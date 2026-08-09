const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.invoke('minimize-window'),
  maximize: () => ipcRenderer.invoke('maximize-window'),
  close: () => ipcRenderer.invoke('close-window'),
  getAppPort: () => ipcRenderer.invoke('get-app-port'),

  // Audio engine
  getDevices: () => ipcRenderer.invoke('get-devices'),
  startAudio: (config) => ipcRenderer.invoke('start-audio', config),
  stopAudio: () => ipcRenderer.invoke('stop-audio'),
  getAudioStatus: () => ipcRenderer.invoke('get-audio-status'),
  setInputVolume: (v) => ipcRenderer.invoke('set-input-volume', v),
  setOutputVolume: (v) => ipcRenderer.invoke('set-output-volume', v),
  setInputDevice: (id) => ipcRenderer.invoke('set-input-device', id),
  setOutputDevice: (id) => ipcRenderer.invoke('set-output-device', id),

  // Effects
  setEffect: (name, params) => ipcRenderer.invoke('set-effect', name, params),
  toggleEffect: (name, enabled) => ipcRenderer.invoke('toggle-effect', name, enabled),
  setEffectsChain: (effects) => ipcRenderer.invoke('set-effects-chain', effects),
  updateAudioStats: (data) => ipcRenderer.invoke('update-audio-stats', data),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // Presets
  getPresets: () => ipcRenderer.invoke('get-presets'),
  savePreset: (p) => ipcRenderer.invoke('save-preset', p),
  deletePreset: (id) => ipcRenderer.invoke('delete-preset', id),
  backupProfiles: () => ipcRenderer.invoke('backup-profiles'),
  restoreProfiles: () => ipcRenderer.invoke('restore-profiles'),
  backupRecordings: (items) => ipcRenderer.invoke('backup-recordings', items),
  restoreRecordings: () => ipcRenderer.invoke('restore-recordings'),
  saveRecording: (rec) => ipcRenderer.invoke('save-recording', rec),
  deleteRecording: (id) => ipcRenderer.invoke('delete-recording', id),
  loadRecordings: () => ipcRenderer.invoke('load-recordings'),
  getSystemOutputDevices: () => ipcRenderer.invoke('get-system-output-devices'),
  setSystemDefaultOutput: (name) => ipcRenderer.invoke('set-system-default-output', name),
  restoreSystemDefaultOutput: () => ipcRenderer.invoke('restore-system-default-output'),

  // External
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  importFile: (opts) => ipcRenderer.invoke('import-file', opts),
  selectFolder: (opts) => ipcRenderer.invoke('select-folder', opts),

  // Virtual Audio Adapter
  checkAdapterInstalled: () => ipcRenderer.invoke('check-adapter-installed'),
  installAdapter: () => ipcRenderer.invoke('install-adapter'),
  uninstallAdapter: () => ipcRenderer.invoke('uninstall-adapter'),
  getAdapterInfo: () => ipcRenderer.invoke('get-adapter-info'),
  onAdapterStatus: (cb) => ipcRenderer.on('adapter-status', (e, v) => cb(v)),
  onAdapterInstalling: (cb) => ipcRenderer.on('adapter-installing', (e, v) => cb(v)),
  onAdapterProgress: (cb) => ipcRenderer.on('adapter-progress', (e, v) => cb(v)),

  // Video
  getVideoSources: () => ipcRenderer.invoke('get-video-sources'),
  openObsBrowserSource: (url) => ipcRenderer.invoke('open-obs-browser-source', url),
  setVideoState: (data) => ipcRenderer.invoke('set-video-state', data),
  getVideoState: () => ipcRenderer.invoke('get-video-state'),
  startObsServer: () => ipcRenderer.invoke('start-obs-server'),
  stopObsServer: () => ipcRenderer.invoke('stop-obs-server'),
  sendObsFrame: (jpegBase64) => ipcRenderer.send('obs-frame', jpegBase64),

  // Event listeners
  onInputLevel: (cb) => ipcRenderer.on('input-level', (e, v) => cb(v)),
  onOutputLevel: (cb) => ipcRenderer.on('output-level', (e, v) => cb(v)),
  onSystemStats: (cb) => ipcRenderer.on('system-stats', (e, v) => cb(v)),
  onLogMessage: (cb) => ipcRenderer.on('log-message', (e, v) => cb(v)),
  onWindowResized: (cb) => ipcRenderer.on('window-resized', (e, v) => cb(v)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch)
});
