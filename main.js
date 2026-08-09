const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, dialog, screen, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');

let mainWindow = null;
let tray = null;
let isQuitting = false;

const APP_WIDTH = 900;
const APP_HEIGHT = 680;
const MIN_WIDTH = 780;
const MIN_HEIGHT = 600;

function getAppPath() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function getDataPath() {
  return app.getPath('userData');
}

function getPresetsDir() {
  const dir = path.join(getAppPath(), 'presets');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRecordingsDir() {
  const dir = path.join(getDataPath(), 'recordings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRecordingsIndexPath() {
  return path.join(getRecordingsDir(), 'recordings.json');
}

function loadRecordingsIndex() {
  try {
    if (fs.existsSync(getRecordingsIndexPath())) {
      return JSON.parse(fs.readFileSync(getRecordingsIndexPath(), 'utf-8'));
    }
  } catch (e) {}
  return [];
}

function saveRecordingsIndex(index) {
  fs.writeFileSync(getRecordingsIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
}

function getLogsDir() {
  const dir = path.join(getDataPath(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}
function crc32(buf) {
  const table = getCrcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}
function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  Object.entries(files).forEach(([name, file]) => {
    const data = file.data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.concat([local, nameBuf, data]);
    central.push({ nameBuf, crc, size: data.length, offset, time, date });
    chunks.push(entry);
    offset += entry.length;
  });
  const cdStart = offset;
  const cdChunks = [];
  central.forEach(c => {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(0, 38);
    h.writeUInt32LE(c.offset, 42);
    cdChunks.push(Buffer.concat([h, c.nameBuf]));
  });
  const cd = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, eocd]);
}
function readZip(buffer) {
  const files = {};
  let eocd = -1;
  const from = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Invalid ZIP: no end of central directory');
  const cdCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  let offset = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP: bad central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP: bad local header for ' + name);
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataBuf = buffer.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(dataBuf);
    else if (method === 8) data = zlib.inflateRawSync(dataBuf);
    else throw new Error('Unsupported ZIP compression method: ' + method);
    files[name] = data;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
function extFromType(type) {
  if (!type) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mp3')) return 'mp3';
  return 'webm';
}

function loadSettings() {
  const settingsPath = path.join(getDataPath(), 'settings.json');
  const defaults = {
    inputDevice: null,
    outputDevice: null,
    outputDeviceLabel: null,
    previousOutputDevice: null,
    previousOutputDeviceLabel: null,
    inputVolume: 80,
    outputVolume: 80,
    recordSource: 'app',
    systemOutputDevice: null,
    theme: 'dark',
    autoStart: false,
    startMinimized: false,
    minimizeToTray: true,
    showLatency: true,
    adapterEnabled: false,
    inputSensitivity: 300,
    outputSensitivity: 100,
    autoStartVideo: false,
    videoDevice: null,
    videoDeviceLabel: null,
    activeVideoEffect: 'none',
    activeProfileId: null,
    effects: {
      pitchShift: { enabled: false, value: 0 },
      formantShift: { enabled: false, value: 0 },
      reverb: { enabled: false, value: 30 },
      echo: { enabled: false, value: 0 },
      chorus: { enabled: false, value: 0 },
      compressor: { enabled: false, value: 50 },
      limiter: { enabled: false, value: 90 },
      equalizer: { enabled: false, value: 50 },
      bassBoost: { enabled: false, value: 0 },
      trebleBoost: { enabled: false, value: 0 },
      distortion: { enabled: false, value: 0 },
      radio: { enabled: false, value: 50 },
      telephone: { enabled: false, value: 50 },
      robot: { enabled: false, value: 50 },
      alien: { enabled: false, value: 50 },
      monster: { enabled: false, value: 50 },
      childVoice: { enabled: false, value: 50 },
      deepVoice: { enabled: false, value: 50 },
      chipmunk: { enabled: false, value: 50 },
      hall: { enabled: false, value: 50 },
      cave: { enabled: false, value: 50 },
      stadium: { enabled: false, value: 50 },
      autoTune: { enabled: false, value: 50 }
    },
    windowBounds: null
  };
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return { ...defaults, ...data, effects: { ...defaults.effects, ...(data.effects || {}) } };
    }
  } catch (e) { console.error('Settings load error:', e); }
  return defaults;
}

function saveSettings(settings) {
  const settingsPath = path.join(getDataPath(), 'settings.json');
  if (mainWindow && mainWindow.getBounds) {
    settings.windowBounds = mainWindow.getBounds();
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

function log(level, message) {
  const ts = new Date().toLocaleTimeString('en-GB');
  const line = `[${ts}] [${level}] ${message}`;
  console.log(line);
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    sendToRenderer('log-message', { level, message, timestamp: ts });
  }
  try {
    const logFile = path.join(getLogsDir(), `app-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {}
}

function createLoadingHTML() {
  return `<!DOCTYPE html><html><head><style>
    body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
    background:linear-gradient(135deg,#0a0a1a 0%,#1a1a3e 50%,#0a0a1a 100%);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;
    -webkit-app-region:drag;user-select:none;}
    .loader{text-align:center;}
    .spinner{width:50px;height:50px;border:3px solid rgba(124,58,237,0.2);
    border-top-color:#7c3aed;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px;}
    @keyframes spin{to{transform:rotate(360deg)}}
    p{margin:0;opacity:0.7;font-size:14px;}
  </style></head><body><div class="loader"><div class="spinner"></div><p>Loading VoiceEffect...</p></div></body></html>`;
}

function createWindow() {
  const bounds = loadSettings().windowBounds;
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const x = bounds ? Math.min(bounds.x, screenW - APP_WIDTH) : Math.round((screenW - APP_WIDTH) / 2);
  const y = bounds ? Math.min(bounds.y, screenH - APP_HEIGHT) : Math.round((screenH - APP_HEIGHT) / 2);

  mainWindow = new BrowserWindow({
    width: bounds?.width || APP_WIDTH,
    height: bounds?.height || APP_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x, y,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a1a',
    show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false
      }
  });

  mainWindow.loadURL('data:text/html,' + encodeURIComponent(createLoadingHTML()));

  mainWindow.once('ready-to-show', () => {
    sendBlocked = true;
    const settings = loadSettings();
    if (!settings.startMinimized) {
      mainWindow.show();
    }

    const appUrl = getAppUrl();
    if (appUrl) {
      mainWindow.loadURL(appUrl);
    } else {
      mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
    }
    setTimeout(() => { sendBlocked = false; }, 500);
    if (mainWindow.webContents) {
      mainWindow.webContents.setBackgroundThrottling(false);
      mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        try {
          const logFile = path.join(getLogsDir(), `app-${new Date().toISOString().slice(0, 10)}.log`);
          const ts = new Date().toLocaleTimeString('en-GB');
          const lvl = ['VERBOSE','INFO','WARNING','ERROR'][level] || 'LOG';
          fs.appendFileSync(logFile, `[${ts}] [RENDERER][${lvl}] ${message}\n`);
        } catch(e) {}
      });
    }
  });

  mainWindow.on('close', (e) => {
    sendBlocked = true;
    const settings = loadSettings();
    if (!isQuitting) {
      e.preventDefault();
      if (settings.minimizeToTray !== false) {
        mainWindow.hide();
      } else {
        isQuitting = true;
        app.quit();
      }
      return false;
    }
  });

  mainWindow.on('closed', () => {
    sendBlocked = true;
    mainWindow = null;
  });

  mainWindow.on('resize', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendToRenderer('window-resized', mainWindow.getBounds());
      }
    } catch(e) {}
  });
}

function createTray() {
  let trayIcon;
  const iconPath = path.join(getAppPath(), 'data', 'icon.png');
  try {
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } else {
      trayIcon = nativeImage.createEmpty();
    }
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('VoiceEffect');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

let audioEngine = null;
let virtualAdapter = null;
const systemAudioRouting = require('./system-audio-routing');
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let appHttpServer = null;
let obsHttpServer = null;
let videoStateMain = { effect: 'none', videoDevice: null, videoDeviceLabel: null };

function startAppServer() {
  if (appHttpServer) return;
  const mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.cjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml', '.task': 'application/octet-stream'
  };
  appHttpServer = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/public/index.html';

    let filePath = null;
    const publicDir = path.join(__dirname, 'public');
    const nodeModDir = path.join(__dirname, 'node_modules');
    const dataDir = path.join(__dirname, 'data');

    if (urlPath.startsWith('/wasm/')) {
      filePath = path.join(nodeModDir, '@mediapipe', 'tasks-vision', 'wasm', urlPath.slice(6));
    } else if (urlPath.startsWith('/mediapipe/')) {
      filePath = path.join(nodeModDir, '@mediapipe', 'tasks-vision', urlPath.slice(11));
    } else if (urlPath.startsWith('/data/')) {
      filePath = path.join(dataDir, urlPath.slice(6));
    } else if (urlPath.startsWith('/node_modules/')) {
      filePath = path.join(__dirname, urlPath);
    } else {
      filePath = path.join(publicDir, urlPath);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(filePath).pipe(res);
  });
  appHttpServer.listen(0, '127.0.0.1', () => {
    const port = appHttpServer.address().port;
    log('INFO', 'App HTTP server started on port ' + port);
  });
  appHttpServer.on('error', (e) => {
    log('ERROR', 'App HTTP server error: ' + e.message);
  });
}

function getAppUrl() {
  if (appHttpServer) {
    const port = appHttpServer.address().port;
    return 'http://127.0.0.1:' + port + '/index.html';
  }
  return null;
}

function getVirtualAdapter() {
  if (!virtualAdapter) {
    try {
      virtualAdapter = require('./virtual-audio-adapter');
      virtualAdapter.on('log', (msg) => log('INFO', msg));
      virtualAdapter.on('error', (msg) => log('ERROR', msg));
      virtualAdapter.on('status', (data) => {
        sendToRenderer('adapter-status', data);
      });
      virtualAdapter.on('installing', (data) => {
        sendToRenderer('adapter-installing', data);
      });
    } catch (e) {
      log('ERROR', 'Failed to load virtual audio adapter: ' + e.message);
    }
  }
  return virtualAdapter;
}

function getAudioEngine() {
  if (!audioEngine) {
    try {
      audioEngine = require('./audio-engine');
      audioEngine.on('log', (msg) => log('INFO', msg));
      audioEngine.on('error', (msg) => log('ERROR', msg));
      audioEngine.on('input-level', (level) => {
        sendToRenderer('input-level', level);
      });
      audioEngine.on('output-level', (level) => {
        sendToRenderer('output-level', level);
      });
      audioEngine.on('cpu-usage', (data) => {
        sendToRenderer('system-stats', data);
      });
    } catch (e) {
      log('ERROR', 'Failed to load audio engine: ' + e.message);
    }
  }
  return audioEngine;
}

function setupIPC() {
  ipcMain.handle('get-devices', async () => {
    const engine = getAudioEngine();
    if (engine) {
      try { return engine.getDevices(); }
      catch (e) { log('ERROR', 'Device enumeration failed: ' + e.message); }
    }
    return { inputs: [], outputs: [] };
  });

  ipcMain.handle('start-audio', async (event, config) => {
    const engine = getAudioEngine();
    if (engine) {
      try {
        engine.start(config);
        log('INFO', 'Audio engine started');
        return { success: true };
      } catch (e) {
        log('ERROR', 'Audio start failed: ' + e.message);
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'Audio engine not available' };
  });

  ipcMain.handle('stop-audio', async () => {
    const engine = getAudioEngine();
    if (engine) {
      try {
        engine.stop();
        log('INFO', 'Audio engine stopped');
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false };
  });

  ipcMain.handle('get-audio-status', async () => {
    const engine = getAudioEngine();
    return engine ? engine.getStatus() : { running: false };
  });

  ipcMain.handle('set-input-volume', async (event, volume) => {
    const engine = getAudioEngine();
    if (engine) engine.setInputVolume(volume / 100);
  });

  ipcMain.handle('set-output-volume', async (event, volume) => {
    const engine = getAudioEngine();
    if (engine) engine.setOutputVolume(volume / 100);
  });

  ipcMain.handle('set-effect', async (event, name, params) => {
    const engine = getAudioEngine();
    if (engine) engine.setEffect(name, params);
  });

  ipcMain.handle('toggle-effect', async (event, name, enabled) => {
    const engine = getAudioEngine();
    if (engine) engine.toggleEffect(name, enabled);
  });

  ipcMain.handle('set-effects-chain', async (event, effects) => {
    const engine = getAudioEngine();
    if (engine) engine.setEffectsChain(effects);
  });

  ipcMain.handle('update-audio-stats', async (event, data) => {
    const engine = getAudioEngine();
    if (engine) engine.updateStats(data);
  });

  ipcMain.handle('set-input-device', async (event, deviceId) => {
    const engine = getAudioEngine();
    if (engine) engine.setInputDevice(deviceId);
  });

  ipcMain.handle('set-output-device', async (event, deviceId) => {
    const engine = getAudioEngine();
    if (engine) engine.setOutputDevice(deviceId);
  });

  ipcMain.handle('check-adapter-installed', async () => {
    const adapter = getVirtualAdapter();
    if (adapter) {
      try {
        const installed = await adapter.checkInstalled();
        return { installed };
      } catch (e) {
        return { installed: false, error: e.message };
      }
    }
    return { installed: false, error: 'Adapter module not available' };
  });

  ipcMain.handle('install-adapter', async (event) => {
    const adapter = getVirtualAdapter();
    if (adapter) {
      try {
        const result = await adapter.install((progress) => {
          sendToRenderer('adapter-progress', progress);
        });
        return result;
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'Adapter module not available' };
  });

  ipcMain.handle('uninstall-adapter', async () => {
    const adapter = getVirtualAdapter();
    if (adapter) {
      try {
        const result = await adapter.uninstall();
        return result;
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'Adapter module not available' };
  });

  ipcMain.handle('get-adapter-info', async () => {
    const adapter = getVirtualAdapter();
    if (adapter) {
      try {
        return { info: adapter.getDeviceInfo(), installed: adapter.isInstalled() };
      } catch (e) {
        return { info: [], installed: false, error: e.message };
      }
    }
    return { info: [], installed: false };
  });

  ipcMain.handle('get-settings', async () => loadSettings());

  ipcMain.handle('save-settings', async (event, settings) => {
    saveSettings(settings);
    log('INFO', 'Settings saved');
    return { success: true };
  });

  ipcMain.handle('get-presets', async () => {
    const dir = getPresetsDir();
    const presets = [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          presets.push({ id: f.replace('.json', ''), ...data });
        } catch (e) {}
      }
    } catch (e) {}
    return presets;
  });

  ipcMain.handle('save-preset', async (event, preset) => {
    try {
      const id = preset.id || preset.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const filePath = path.join(getPresetsDir(), id + '.json');
      fs.writeFileSync(filePath, JSON.stringify(preset, null, 2), 'utf-8');
      return { success: true, id };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('delete-preset', async (event, presetId) => {
    try {
      const filePath = path.join(getPresetsDir(), presetId + '.json');
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backup-profiles', async () => {
    const dir = getPresetsDir();
    const presets = [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          presets.push({ id: f.replace('.json', ''), ...data });
        } catch(e) {}
      }
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Backup Profiles',
        defaultPath: 'VoiceEffect_Profiles_Backup.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(presets, null, 2), 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('restore-profiles', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Restore Profiles',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
      const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
      if (!Array.isArray(data)) throw new Error('Invalid backup file format');
      const dir = getPresetsDir();
      for (const preset of data) {
        if (preset.id) {
          fs.writeFileSync(path.join(dir, preset.id + '.json'), JSON.stringify(preset, null, 2), 'utf-8');
        }
      }
      return { success: true, count: data.length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backup-recordings', async (event, items) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Backup Records',
        defaultPath: 'VoiceEffect_Records_Backup_' + new Date().toISOString().slice(0, 10) + '.zip',
        filters: [{ name: 'ZIP Files', extensions: ['zip'] }]
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      const files = {};
      const meta = [];
      items.forEach((it, i) => {
        const ext = extFromType(it.type);
        const fname = 'record_' + (i + 1) + '.' + ext;
        files[fname] = { data: Buffer.from(it.data, 'base64') };
        meta.push({ file: fname, name: it.name, date: it.date, dur: it.dur, type: it.type || 'audio/webm' });
      });
      files['recordings.json'] = { data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') };
      const zip = createZip(files);
      fs.writeFileSync(result.filePath, zip);
      log('INFO', 'Backed up ' + items.length + ' recording(s)');
      return { success: true, count: items.length, filePath: result.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('restore-recordings', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Restore Records',
        filters: [{ name: 'ZIP Files', extensions: ['zip'] }],
        properties: ['openFile']
      });
      if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
      const buffer = fs.readFileSync(result.filePaths[0]);
      const files = readZip(buffer);
      let meta = [];
      if (files['recordings.json']) {
        try { meta = JSON.parse(files['recordings.json'].toString('utf8')); } catch (e) { meta = []; }
      }
      const items = [];
      if (meta.length) {
        meta.forEach(m => {
          const buf = files[m.file];
          if (buf) items.push({ name: m.name, date: m.date, dur: m.dur, type: m.type || 'audio/webm', data: buf.toString('base64') });
        });
      } else {
        Object.keys(files).filter(n => /^record_.*\.(webm|ogg|wav|mp3)$/i.test(n)).sort().forEach(n => {
          const ext = n.split('.').pop().toLowerCase();
          const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/' + ext;
          items.push({ name: n, date: null, dur: null, type: mime, data: files[n].toString('base64') });
        });
      }
      if (items.length === 0) return { success: false, error: 'No recordings found in the selected file' };
      log('INFO', 'Restored ' + items.length + ' recording(s)');
      return { success: true, count: items.length, items };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('save-recording', async (event, rec) => {
    try {
      const dir = getRecordingsDir();
      const index = loadRecordingsIndex();
      const ext = extFromType(rec.type);
      const fileName = rec.id + '.' + ext;
      fs.writeFileSync(path.join(dir, fileName), Buffer.from(rec.data, 'base64'));
      const entry = { id: rec.id, name: rec.name, date: rec.date, dur: rec.dur, type: rec.type || 'audio/webm', file: fileName };
      const i = index.findIndex(x => x.id === rec.id);
      if (i === -1) index.push(entry);
      else index[i] = entry;
      saveRecordingsIndex(index);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('delete-recording', async (event, id) => {
    try {
      const index = loadRecordingsIndex();
      const i = index.findIndex(x => x.id === id);
      if (i !== -1) {
        if (index[i].file) {
          try { fs.unlinkSync(path.join(getRecordingsDir(), index[i].file)); } catch (e) {}
        }
        index.splice(i, 1);
        saveRecordingsIndex(index);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('load-recordings', async () => {
    try {
      const index = loadRecordingsIndex();
      const items = [];
      for (const entry of index) {
        const filePath = path.join(getRecordingsDir(), entry.file);
        if (fs.existsSync(filePath)) {
          items.push({ id: entry.id, name: entry.name, date: entry.date, dur: entry.dur, type: entry.type, data: fs.readFileSync(filePath).toString('base64') });
        }
      }
      return { success: true, items };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-system-output-devices', async () => {
    try {
      return { success: true, devices: await systemAudioRouting.getOutputs() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('set-system-default-output', async (event, name) => {
    try {
      const result = await systemAudioRouting.setDefaultOutput(String(name));
      systemAudioRouting.persistOverride();
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('restore-system-default-output', async () => {
    try {
      await systemAudioRouting.restoreDefaultOutput();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-system-stats', async () => {
    const now = Date.now();
    const elapsedMs = now - lastCpuTime;
    const currentUsage = process.cpuUsage();
    const userDelta = currentUsage.user - lastCpuUsage.user;
    const systemDelta = currentUsage.system - lastCpuUsage.system;
    const cpuPercent = elapsedMs > 0 ? ((userDelta + systemDelta) / 1000 / elapsedMs) * 100 : 0;
    lastCpuUsage = currentUsage;
    lastCpuTime = now;
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const engine = audioEngine;
    const latency = (engine && engine.stats) ? engine.stats.latency : 0;
    return {
      cpu: Math.round(Math.min(100, Math.max(0, cpuPercent)) * 10) / 10,
      ramUsed: Math.round((totalMem - freeMem) / 1024 / 1024),
      ramTotal: Math.round(totalMem / 1024 / 1024),
      ramPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
      processRam: Math.round(mem.rss / 1024 / 1024),
      uptime: Math.round(os.uptime()),
      latency: latency
    };
  });

  ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('maximize-window', () => {
    if (mainWindow) {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    }
  });
  ipcMain.handle('close-window', () => { if (mainWindow) mainWindow.close(); });
  ipcMain.handle('get-app-port', () => { return appHttpServer && appHttpServer.address() ? appHttpServer.address().port : null; });
  ipcMain.handle('read-mediapipe-module', () => {
    const mjsPath = path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision', 'vision_bundle.mjs');
    return fs.readFileSync(mjsPath, 'utf8');
  });
  ipcMain.handle('read-mediapipe-wasm', (event, filename) => {
    const wasmPath = path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm', filename);
    if (fs.existsSync(wasmPath)) return fs.readFileSync(wasmPath);
    return null;
  });

  ipcMain.handle('open-external', async (event, url) => {
    if (url.startsWith('http')) shell.openExternal(url);
  });

  ipcMain.handle('open-logs-folder', async () => {
    shell.openPath(getLogsDir());
  });

  ipcMain.handle('import-file', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options?.title || 'Select File',
      filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('select-folder', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options?.title || 'Select Folder',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('get-video-sources', async () => {
    return { sources: [] };
  });

  ipcMain.handle('open-obs-browser-source', async (event, url) => {
    shell.openExternal(url || 'http://localhost:8080');
  });

  ipcMain.handle('set-video-state', async (event, data) => {
    videoStateMain.effect = data.effect || 'none';
    videoStateMain.videoDevice = data.videoDevice || null;
    videoStateMain.videoDeviceLabel = data.videoDeviceLabel || null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('video-state-update', videoStateMain);
    }
  });

  ipcMain.handle('get-video-state', async () => videoStateMain);

  ipcMain.handle('start-obs-server', async () => {
    return startObsServer();
  });

  ipcMain.handle('stop-obs-server', async () => {
    return stopObsServer();
  });

  ipcMain.on('obs-frame', (event, jpegBase64) => {
    const buf = Buffer.from(jpegBase64, 'base64');
    broadcastFrame(buf);
  });
}

let sendBlocked = false;

let obsClients = [];
let latestFrame = null;

function startObsServer() {
  if (obsHttpServer) return { success: true, port: 8080 };
  try {
    obsHttpServer = http.createServer((req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200, {
          'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        if (latestFrame) {
          res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n');
          res.write(latestFrame);
          res.write('\r\n');
        }
        obsClients.push(res);
        req.on('close', () => {
          obsClients = obsClients.filter(c => c !== res);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getObsPageHTML());
    });
    obsHttpServer.listen(8080, '127.0.0.1', () => {
      log('INFO', 'OBS HTTP server started on port 8080');
    });
    obsHttpServer.on('error', (e) => {
      log('ERROR', 'OBS HTTP server error: ' + e.message);
      obsHttpServer = null;
    });
    return { success: true, port: 8080 };
  } catch(e) {
    log('ERROR', 'Failed to start OBS server: ' + e.message);
    return { success: false, error: e.message };
  }
}

function stopObsServer() {
  obsClients.forEach(c => { try { c.end(); } catch(e) {} });
  obsClients = [];
  if (obsHttpServer) {
    obsHttpServer.close();
    obsHttpServer = null;
    log('INFO', 'OBS HTTP server stopped');
  }
  return { success: true };
}

function broadcastFrame(jpegBuffer) {
  latestFrame = jpegBuffer;
  if (obsClients.length === 0) return;
  const dead = [];
  obsClients.forEach(res => {
    try {
      res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n');
      res.write(jpegBuffer);
      res.write('\r\n');
    } catch(e) { dead.push(res); }
  });
  if (dead.length) obsClients = obsClients.filter(c => !dead.includes(c));
}

function getObsPageHTML() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>VideoEffects-OBS</title>
<style>*{margin:0;padding:0}body{background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;height:100vh}img{max-width:100%;max-height:100%;display:block}</style>
</head><body>
<img id="stream" src="/stream" alt="Waiting for video stream...">
<script>
var img=document.getElementById('stream');
img.onerror=function(){setTimeout(function(){img.src='/stream?'+Date.now()},2000);};
</script>
</body></html>`;
}

function sendToRenderer(channel, data) {
  if (sendBlocked) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, data);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  startAppServer();

  systemAudioRouting.init(app.getPath('userData'));
  systemAudioRouting.restorePendingOnStart();

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem' || permission === 'display-capture') {
      callback(true);
    } else {
      callback(false);
    }
  });
  ses.setPermissionCheckHandler(() => true);

  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (sources && sources.length > 0) {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          callback({ video: null });
        }
      })
      .catch(() => {
        callback({ video: null });
      });
  });

  createWindow();
  createTray();
  setupIPC();
  log('INFO', 'VoiceEffect started');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (audioEngine) {
    try { audioEngine.stop(); } catch (e) {}
  }
  if (systemAudioRouting.currentOverride) {
    systemAudioRouting.restoreDefaultOutputSync();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
