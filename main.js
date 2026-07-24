const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, dialog, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

function getLogsDir() {
  const dir = path.join(getDataPath(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSettings() {
  const settingsPath = path.join(getDataPath(), 'settings.json');
  const defaults = {
    inputDevice: null,
    outputDevice: null,
    sampleRate: 44100,
    bufferSize: 256,
    inputVolume: 80,
    outputVolume: 80,
    theme: 'dark',
    language: 'en',
    autoStart: false,
    minimizeToTray: true,
    showLatency: true,
    enableNoiseGate: true,
    noiseGateThreshold: 0.01,
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
      webSecurity: true
    }
  });

  mainWindow.loadURL('data:text/html,' + encodeURIComponent(createLoadingHTML()));

  mainWindow.once('ready-to-show', () => {
    sendBlocked = true;
    mainWindow.show();

    mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
    setTimeout(() => { sendBlocked = false; }, 500);
  });

  mainWindow.on('close', (e) => {
    sendBlocked = true;
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
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

  ipcMain.handle('get-system-stats', async () => {
    const cpus = os.cpus();
    const cpuUsage = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return acc + (cpu.times.user + cpu.times.system) / total;
    }, 0) / cpus.length * 100;
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      cpu: Math.round(cpuUsage * 10) / 10,
      ramUsed: Math.round((totalMem - freeMem) / 1024 / 1024),
      ramTotal: Math.round(totalMem / 1024 / 1024),
      ramPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
      processRam: Math.round(mem.rss / 1024 / 1024),
      uptime: Math.round(os.uptime())
    };
  });

  ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('maximize-window', () => {
    if (mainWindow) {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    }
  });
  ipcMain.handle('close-window', () => { if (mainWindow) mainWindow.close(); });

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
}

let sendBlocked = false;

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

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem') {
      callback(true);
    } else {
      callback(false);
    }
  });
  ses.setPermissionCheckHandler(() => true);

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
