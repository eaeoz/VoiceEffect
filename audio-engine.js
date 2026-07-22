const EventEmitter = require('events');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

class AudioEngine extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.inputVolume = 0.8;
    this.outputVolume = 0.8;
    this.inputDeviceId = null;
    this.outputDeviceId = null;
    this.sampleRate = 44100;
    this.bufferSize = 256;
    this.effectsChain = {};
    this.activeModel = null;
    this.modelSession = null;
    this.onnxrt = null;
    this._deviceCache = null;
    this._deviceCacheTime = 0;
    this.stats = { processed: 0, dropped: 0, latency: 0, startTime: null };

    try {
      this.onnxrt = require('onnxruntime-node');
      this.emit('log', 'ONNX Runtime loaded');
    } catch (e) {
      this.emit('log', 'ONNX Runtime not available');
    }
  }

  getDevices() {
    const now = Date.now();
    if (this._deviceCache && (now - this._deviceCacheTime < 5000)) {
      return this._deviceCache;
    }

    const devices = { inputs: [], outputs: [], raw: [] };

    try {
      const psScript = `
        $devices = @();
        Get-PnpDevice -Class 'AudioEndpoint' -Status OK -ErrorAction SilentlyContinue | ForEach-Object {
          $name = $_.FriendlyName;
          $id = $_.InstanceId;
          $isInput = $false;
          $isOutput = $false;
          if ($id -match '0\\.0\\.1\\.') { $isInput = $true };
          if ($id -match '0\\.0\\.0\\.') { $isOutput = $true };
          $devices += [PSCustomObject]@{ Name = $name; InstanceId = $id; IsInput = $isInput; IsOutput = $isOutput; };
        };
        $devices | ConvertTo-Json -Compress;
      `.trim();

      const tmpFile = require('os').tmpdir() + '\\ve-devices.ps1';
      fs.writeFileSync(tmpFile, psScript, 'utf-8');
      const result = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
        { encoding: 'utf-8', timeout: 15000, windowsHide: true }
      );
      try { fs.unlinkSync(tmpFile); } catch(e) {}

      const parsed = JSON.parse(result.trim());
        const devList = Array.isArray(parsed) ? parsed : [parsed];
        const nameCount = {};

        devList.forEach(d => {
          if (!d || !d.Name) return;
          let label = d.Name;
          nameCount[d.Name] = (nameCount[d.Name] || 0) + 1;
          if (nameCount[d.Name] > 1) {
            label = d.Name + (d.IsInput ? ' (Mic)' : ' (Speaker)');
          }
          const dev = {
            id: d.InstanceId || d.Name,
            name: label,
            instanceId: d.InstanceId,
            hostAPI: 'WASAPI'
          };
          devices.raw.push(dev);
          if (d.IsInput) devices.inputs.push({ ...dev });
          if (d.IsOutput) devices.outputs.push({ ...dev });
        });
    } catch (e) {
      this.emit('log', 'PowerShell device enum failed: ' + e.message);
    }

    if (devices.inputs.length === 0) {
      try {
        const result = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Select-Object Name,Status | ConvertTo-Json -Compress"',
          { encoding: 'utf-8', timeout: 10000, windowsHide: true }
        );
        const parsed = JSON.parse(result.trim());
        const list = Array.isArray(parsed) ? parsed : [parsed];
        list.forEach(d => {
          if (!d || !d.Name) return;
          devices.inputs.push({ id: d.Name, name: d.Name, hostAPI: 'WMI' });
          devices.outputs.push({ id: d.Name, name: d.Name, hostAPI: 'WMI' });
        });
      } catch (e2) {
        this.emit('log', 'WMI fallback failed: ' + e2.message);
      }
    }

    this._deviceCache = devices;
    this._deviceCacheTime = now;
    return devices;
  }

  start(config = {}) {
    if (this.running) return;
    this.sampleRate = config.sampleRate || this.sampleRate;
    this.bufferSize = config.bufferSize || this.bufferSize;
    this.inputDeviceId = config.inputDevice ?? this.inputDeviceId;
    this.outputDeviceId = config.outputDevice ?? this.outputDeviceId;
    this.stats = { processed: 0, dropped: 0, latency: 0, startTime: Date.now() };
    this.running = true;
    this.emit('log', `Audio engine started (${this.sampleRate}Hz, buffer: ${this.bufferSize})`);
  }

  stop() {
    this.running = false;
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
    this.emit('log', 'Audio engine stopped');
  }

  _startStatsMonitor() {
    this._statsInterval = setInterval(() => {
      if (!this.running) return;
      const uptime = this.stats.startTime ? (Date.now() - this.stats.startTime) / 1000 : 0;
      this.emit('cpu-usage', {
        latency: this.stats.latency,
        processed: this.stats.processed,
        dropped: this.stats.dropped,
        uptime: Math.round(uptime)
      });
    }, 1000);
  }

  setInputVolume(vol) { this.inputVolume = Math.max(0, Math.min(1, vol)); }
  setOutputVolume(vol) { this.outputVolume = Math.max(0, Math.min(1, vol)); }
  setInputDevice(id) { this.inputDeviceId = id; this.emit('log', 'Input device: ' + id); }
  setOutputDevice(id) { this.outputDeviceId = id; this.emit('log', 'Output device: ' + id); }

  toggleEffect(name, enabled) {
    if (!this.effectsChain[name]) this.effectsChain[name] = { enabled: false, value: 50 };
    this.effectsChain[name].enabled = enabled;
    this.emit('effect-changed', name, this.effectsChain[name]);
  }

  setEffect(name, params) {
    if (!this.effectsChain[name]) this.effectsChain[name] = { enabled: false, value: 50 };
    Object.assign(this.effectsChain[name], params);
    this.emit('effect-changed', name, this.effectsChain[name]);
  }

  setEffectsChain(effects) { this.effectsChain = { ...effects }; }

  async loadModel(modelPath) {
    if (!this.onnxrt) throw new Error('ONNX Runtime not available');
    if (this.modelSession) this.unloadModel();
    this.modelSession = await this.onnxrt.InferenceSession.create(modelPath);
    this.activeModel = modelPath;
    this.emit('log', 'Model loaded: ' + path.basename(modelPath));
  }

  unloadModel() {
    if (this.modelSession) {
      try { this.modelSession.release && this.modelSession.release(); } catch(e) {}
      this.modelSession = null;
      this.activeModel = null;
      this.emit('log', 'Model unloaded');
    }
  }

  updateStats(data) {
    if (data.latency !== undefined) this.stats.latency = data.latency;
    if (data.processed !== undefined) this.stats.processed = data.processed;
    if (data.dropped !== undefined) this.stats.dropped = data.dropped;
  }

  getStatus() {
    return {
      running: this.running,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
      inputDevice: this.inputDeviceId,
      outputDevice: this.outputDeviceId,
      inputVolume: this.inputVolume,
      outputVolume: this.outputVolume,
      effects: { ...this.effectsChain },
      modelLoaded: !!this.modelSession,
      activeModel: this.activeModel ? path.basename(this.activeModel) : null,
      stats: { ...this.stats }
    };
  }
}

module.exports = new AudioEngine();
