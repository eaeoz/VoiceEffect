const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.invoke('minimize-window'),
  maximize: () => ipcRenderer.invoke('maximize-window'),
  close: () => ipcRenderer.invoke('close-window'),

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

  // Models
  getModels: () => ipcRenderer.invoke('get-models'),
  addModel: (p) => ipcRenderer.invoke('add-model', p),
  removeModel: (id) => ipcRenderer.invoke('remove-model', id),
  saveModelMeta: (id, meta) => ipcRenderer.invoke('save-model-meta', id, meta),
  loadModel: (id) => ipcRenderer.invoke('load-model', id),
  unloadModel: () => ipcRenderer.invoke('unload-model'),
  getModelsDir: () => ipcRenderer.invoke('get-models-dir'),

  // Presets
  getPresets: () => ipcRenderer.invoke('get-presets'),
  savePreset: (p) => ipcRenderer.invoke('save-preset', p),
  deletePreset: (id) => ipcRenderer.invoke('delete-preset', id),

  // External
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  openModelsFolder: () => ipcRenderer.invoke('open-models-folder'),
  importFile: (opts) => ipcRenderer.invoke('import-file', opts),
  selectFolder: (opts) => ipcRenderer.invoke('select-folder', opts),

  // Event listeners
  onInputLevel: (cb) => ipcRenderer.on('input-level', (e, v) => cb(v)),
  onOutputLevel: (cb) => ipcRenderer.on('output-level', (e, v) => cb(v)),
  onSystemStats: (cb) => ipcRenderer.on('system-stats', (e, v) => cb(v)),
  onLogMessage: (cb) => ipcRenderer.on('log-message', (e, v) => cb(v)),
  onWindowResized: (cb) => ipcRenderer.on('window-resized', (e, v) => cb(v)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch)
});
