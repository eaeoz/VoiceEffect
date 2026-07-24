class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.activeEffects = {};
    this.processedCount = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'effects') this.activeEffects = msg.effects;
      if (msg.type === 'toggle') this.activeEffects[msg.name] = msg.params;
      if (msg.type === 'set') {
        if (!this.activeEffects[msg.name]) this.activeEffects[msg.name] = { enabled: false, value: 50 };
        this.activeEffects[msg.name].value = msg.value;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const inData = input[0];
    const outData = output[0];
    const len = outData.length;

    outData.set(inData);

    for (const [name, params] of Object.entries(this.activeEffects)) {
      if (!params || !params.enabled) continue;
      this.applyEffect(name, outData, params.value || 50, len, sampleRate);
    }

    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(outData);
    }

    this.processedCount++;
    if (this.processedCount % 100 === 0) {
      this.port.postMessage({ type: 'stats', processed: this.processedCount });
    }
    return true;
  }

  applyEffect(name, data, value, len, sr) {
    switch (name) {
      case 'pitchShift': {
        const factor = Math.pow(2, (value - 50) / 24);
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const s = i * factor;
          const idx = Math.floor(s);
          const frac = s - idx;
          tmp[i] = (idx < len ? data[idx] : 0) * (1 - frac) + (idx + 1 < len ? data[idx + 1] : 0) * frac;
        }
        data.set(tmp);
        break;
      }
      case 'formantShift': {
        const shift = (value - 50) / 50;
        const tmp = new Float32Array(len);
        for (let i = 2; i < len - 2; i++) {
          const f = data[i] * 0.6 + (data[i - 1] + data[i + 1]) * 0.15 + (data[i - 2] + data[i + 2]) * 0.05;
          tmp[i] = data[i] + shift * (data[i] - f) * 0.5;
        }
        tmp[0] = data[0]; tmp[1] = data[1]; tmp[len - 2] = data[len - 2]; tmp[len - 1] = data[len - 1];
        data.set(tmp);
        break;
      }
      case 'reverb': {
        const d = value / 100;
        const delays = [1557, 1617, 1491, 1422, 1277, 1356];
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          let s = data[i] * (1 - d * 0.4);
          for (const dl of delays) { if (i >= dl) s += data[i - dl] * d * 0.06; }
          tmp[i] = s;
        }
        data.set(tmp);
        break;
      }
      case 'echo': {
        const delay = Math.round(sr * 0.3);
        const fb = value / 120;
        for (let i = 0; i < len; i++) {
          if (i >= delay) data[i] += data[i - delay] * fb;
        }
        break;
      }
      case 'chorus': {
        const depth = value / 100;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const m = Math.sin(2 * Math.PI * 1.5 * i / sr) * depth * 100;
          const idx = Math.max(0, Math.min(len - 1, Math.round(i + m)));
          tmp[i] = (data[i] + data[idx]) * 0.5;
        }
        data.set(tmp);
        break;
      }
      case 'compressor': {
        const thr = (1 - value / 100);
        const ratio = 1 + (value / 10) * 3;
        for (let i = 0; i < len; i++) {
          const a = Math.abs(data[i]);
          if (a > thr) data[i] = Math.sign(data[i]) * (thr + (a - thr) / ratio);
        }
        break;
      }
      case 'limiter': {
        const lim = value / 100;
        for (let i = 0; i < len; i++) {
          if (Math.abs(data[i]) > lim) data[i] = Math.sign(data[i]) * lim;
        }
        break;
      }
      case 'equalizer': {
        const gain = (value - 50) / 50 * 6;
        let prev = 0;
        for (let i = 0; i < len; i++) {
          prev += 0.1 * (data[i] - prev);
          data[i] += prev * gain / 6;
        }
        break;
      }
      case 'bassBoost': {
        const g = value / 100 * 12;
        let prev = 0;
        for (let i = 0; i < len; i++) {
          prev = 0.95 * prev + 0.05 * data[i];
          data[i] += prev * g / 12;
        }
        break;
      }
      case 'trebleBoost': {
        const g = value / 100 * 12;
        let prev = 0;
        for (let i = 0; i < len; i++) {
          const h = data[i] - (0.05 * prev + 0.95 * data[i]);
          prev = data[i];
          data[i] += h * g / 12;
        }
        break;
      }
      case 'distortion': {
        const g = 1 + (value / 100) * 20;
        for (let i = 0; i < len; i++) {
          data[i] = Math.tanh(data[i] * g) * 0.8;
        }
        break;
      }
      case 'radio': {
        const bp = value / 100;
        let hp = 0, lp = 0, bpf = 0;
        for (let i = 0; i < len; i++) {
          hp = (0.9 + bp * 0.08) * (hp + data[i] - (i > 0 ? data[i - 1] : 0));
          lp = (0.02 + bp * 0.08) * data[i] + (1 - 0.02 - bp * 0.08) * lp;
          bpf = hp - lp;
          data[i] = Math.tanh(bpf / 0.3) * 0.3 * 3;
        }
        break;
      }
      case 'telephone': {
        let hp = 0, lp = 0;
        for (let i = 0; i < len; i++) {
          hp = 0.85 * (hp + data[i] - (i > 0 ? data[i - 1] : 0));
          lp = 0.15 * data[i] + 0.85 * lp;
          data[i] = Math.tanh((hp + lp) / 0.24) * 0.24 * 2.5;
        }
        break;
      }
      case 'robot': {
        const mf = 50 + (value / 100) * 200;
        for (let i = 0; i < len; i++) {
          data[i] *= Math.sin(2 * Math.PI * mf * i / sr) * 2;
        }
        break;
      }
      case 'alien': {
        const mf = 5 + (value / 100) * 50;
        const sh = (value - 50) / 50 * 200;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const m = Math.sin(2 * Math.PI * mf * i / sr);
          const idx = Math.max(0, Math.min(len - 1, i + Math.round(m * 50 + sh)));
          tmp[i] = data[idx];
        }
        data.set(tmp);
        break;
      }
      case 'monster': {
        const f = 1 - (value / 100) * 0.5;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          tmp[i] = (data[Math.floor(i * f)] || 0) * 1.3;
        }
        data.set(tmp);
        break;
      }
      case 'childVoice': {
        const f = 1 + (value / 100) * 0.8;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          tmp[i] = (data[Math.floor(i * f)] || 0) * 0.8;
        }
        data.set(tmp);
        break;
      }
      case 'deepVoice': {
        const f = 1 - (value / 100) * 0.4;
        let prev = 0;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const s = data[Math.floor(i * f)] || 0;
          prev = 0.97 * prev + 0.03 * s;
          tmp[i] = s * 0.5 + prev * 1.5;
        }
        data.set(tmp);
        break;
      }
      case 'chipmunk': {
        const f = 1 + (value / 100) * 1.5;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          tmp[i] = (data[Math.floor(i * f)] || 0) * 0.7;
        }
        data.set(tmp);
        break;
      }
      case 'hall': {
        const delays = [2963, 3857, 4219, 5433];
        const dc = value / 200;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          let s = data[i] * 0.7;
          for (const d of delays) { if (i >= d) s += data[i - d] * dc; }
          tmp[i] = s;
        }
        data.set(tmp);
        break;
      }
      case 'cave': {
        const delays = [1200, 2400, 3600, 4800, 6000];
        const dc = value / 150;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          let s = data[i] * 0.5;
          for (const d of delays) { if (i >= d) s += data[i - d] * dc; }
          tmp[i] = s;
        }
        data.set(tmp);
        break;
      }
      case 'stadium': {
        const delays = [5000, 10000, 15000, 20000, 25000];
        const dc = value / 250;
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          let s = data[i] * 0.6;
          for (const d of delays) { if (i >= d) s += data[i - d] * dc; }
          tmp[i] = s;
        }
        data.set(tmp);
        break;
      }
      case 'autoTune': {
        const corr = value / 100;
        let prev = 0;
        for (let i = 0; i < len; i++) {
          const pitch = data[i] - prev;
          const step = 0.01;
          const corrected = Math.round(pitch / step) * step;
          data[i] = data[i] * (1 - corr) + corrected * corr;
          prev = data[i];
        }
        break;
      }
    }
  }
}

registerProcessor('voice-processor', VoiceProcessor);
