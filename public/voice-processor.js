class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.activeEffects = {};
    this.processedCount = 0;
    
    // Persistent state container for all effects
    this.state = {};
    
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

  getState(name) {
    if (!this.state[name]) {
      this.state[name] = {};
    }
    return this.state[name];
  }

  getDelayBuffer(name, sizeInSeconds) {
    const st = this.getState(name);
    if (!st.delayBuffer) {
      st.size = Math.floor(sampleRate * sizeInSeconds);
      st.delayBuffer = new Float32Array(st.size);
      st.idx = 0;
    }
    return st;
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
        const st = this.getDelayBuffer(name, 0.1);
        const factor = Math.pow(2, (value - 50) / 24);
        const windowSize = Math.floor(sr * 0.05); // 50ms window
        const phaseInc = (1 - factor) / windowSize;
        st.phase = st.phase || 0;
        
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          st.delayBuffer[st.idx] = data[i];
          
          st.phase += phaseInc;
          if (st.phase >= 1.0) st.phase -= 1.0;
          else if (st.phase < 0.0) st.phase += 1.0;
          
          const p1 = st.phase;
          const p2 = (st.phase + 0.5) % 1.0;
          
          const env1 = 1.0 - Math.abs(p1 - 0.5) * 2.0;
          const env2 = 1.0 - Math.abs(p2 - 0.5) * 2.0;
          
          const offset1 = p1 * windowSize;
          const offset2 = p2 * windowSize;
          
          const getSample = (offset) => {
            let readIdx = st.idx - offset;
            if (readIdx < 0) readIdx += st.size;
            const r1 = Math.floor(readIdx);
            const r2 = (r1 + 1) % st.size;
            const frac = readIdx - r1;
            return st.delayBuffer[r1] * (1 - frac) + st.delayBuffer[r2] * frac;
          };
          
          tmp[i] = getSample(offset1) * env1 + getSample(offset2) * env2;
          st.idx = (st.idx + 1) % st.size;
        }
        data.set(tmp);
        break;
      }
      case 'formantShift': {
        const st = this.getState(name);
        if (!st.hist) st.hist = new Float32Array(4);
        const shift = (value - 50) / 50;
        const tmp = new Float32Array(len);
        
        for (let i = 0; i < len; i++) {
          const d_i = data[i];
          const d_m1 = i >= 1 ? data[i-1] : st.hist[3];
          const d_m2 = i >= 2 ? data[i-2] : st.hist[i===1?3:2];
          const d_p1 = i + 1 < len ? data[i+1] : d_i;
          const d_p2 = i + 2 < len ? data[i+2] : d_p1;
          
          const f = d_i * 0.6 + (d_m1 + d_p1) * 0.15 + (d_m2 + d_p2) * 0.05;
          tmp[i] = d_i + shift * (d_i - f) * 0.5;
        }
        
        st.hist[0] = len > 3 ? data[len-4] : 0;
        st.hist[1] = len > 2 ? data[len-3] : 0;
        st.hist[2] = len > 1 ? data[len-2] : 0;
        st.hist[3] = len > 0 ? data[len-1] : 0;
        data.set(tmp);
        break;
      }
      case 'reverb': {
        const d = value / 100;
        const delays = [1557, 1617, 1491, 1422, 1277, 1356];
        const maxDelay = Math.max(...delays);
        const st = this.getDelayBuffer(name, maxDelay / sr + 0.1);
        
        for (let i = 0; i < len; i++) {
          let s = data[i] * (1 - d * 0.4);
          for (const dl of delays) {
            let readIdx = st.idx - dl;
            if (readIdx < 0) readIdx += st.size;
            s += st.delayBuffer[readIdx] * d * 0.06;
          }
          st.delayBuffer[st.idx] = data[i] + (s - data[i]) * 0.5;
          st.idx = (st.idx + 1) % st.size;
          data[i] = s;
        }
        break;
      }
      case 'echo': {
        const delaySamples = Math.round(sr * 0.3);
        const st = this.getDelayBuffer(name, 0.4);
        const fb = value / 120;
        for (let i = 0; i < len; i++) {
          let readIdx = st.idx - delaySamples;
          if (readIdx < 0) readIdx += st.size;
          
          const delayed = st.delayBuffer[readIdx];
          st.delayBuffer[st.idx] = data[i] + delayed * fb;
          data[i] += delayed * fb;
          st.idx = (st.idx + 1) % st.size;
        }
        break;
      }
      case 'chorus': {
        const depth = value / 100;
        const st = this.getDelayBuffer(name, 0.1);
        st.phase = st.phase || 0;
        
        for (let i = 0; i < len; i++) {
          st.delayBuffer[st.idx] = data[i];
          
          const mod = Math.sin(st.phase) * depth * 100;
          let readIdx = st.idx - Math.round(150 + mod);
          while (readIdx < 0) readIdx += st.size;
          
          data[i] = (data[i] + st.delayBuffer[readIdx]) * 0.5;
          st.idx = (st.idx + 1) % st.size;
          st.phase += 2 * Math.PI * 1.5 / sr;
          if (st.phase > 2 * Math.PI) st.phase -= 2 * Math.PI;
        }
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
        const st = this.getState(name);
        st.prev = st.prev || 0;
        for (let i = 0; i < len; i++) {
          st.prev += 0.1 * (data[i] - st.prev);
          data[i] += st.prev * gain / 6;
        }
        break;
      }
      case 'bassBoost': {
        const g = value / 100 * 12;
        const st = this.getState(name);
        st.prev = st.prev || 0;
        for (let i = 0; i < len; i++) {
          st.prev = 0.95 * st.prev + 0.05 * data[i];
          data[i] += st.prev * g / 12;
        }
        break;
      }
      case 'trebleBoost': {
        const g = value / 100 * 12;
        const st = this.getState(name);
        st.prev = st.prev || 0;
        for (let i = 0; i < len; i++) {
          const h = data[i] - (0.05 * st.prev + 0.95 * data[i]);
          st.prev = data[i];
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
        const st = this.getState(name);
        st.hp = st.hp || 0;
        st.lp = st.lp || 0;
        st.prev = st.prev || 0;
        for (let i = 0; i < len; i++) {
          st.hp = (0.9 + bp * 0.08) * (st.hp + data[i] - st.prev);
          st.lp = (0.02 + bp * 0.08) * data[i] + (1 - 0.02 - bp * 0.08) * st.lp;
          const bpf = st.hp - st.lp;
          st.prev = data[i];
          data[i] = Math.tanh(bpf / 0.3) * 0.3 * 3;
        }
        break;
      }
      case 'telephone': {
        const st = this.getState(name);
        st.hp = st.hp || 0;
        st.lp = st.lp || 0;
        st.prev = st.prev || 0;
        for (let i = 0; i < len; i++) {
          st.hp = 0.85 * (st.hp + data[i] - st.prev);
          st.lp = 0.15 * data[i] + 0.85 * st.lp;
          st.prev = data[i];
          data[i] = Math.tanh((st.hp + st.lp) / 0.24) * 0.24 * 2.5;
        }
        break;
      }
      case 'robot': {
        const mf = 50 + (value / 100) * 200;
        const st = this.getState(name);
        st.phase = st.phase || 0;
        for (let i = 0; i < len; i++) {
          data[i] *= Math.sin(st.phase) * 2;
          st.phase += 2 * Math.PI * mf / sr;
          if (st.phase > 2 * Math.PI) st.phase -= 2 * Math.PI;
        }
        break;
      }
      case 'alien': {
        const mf = 5 + (value / 100) * 50;
        const sh = (value - 50) / 50 * 200;
        const st = this.getDelayBuffer(name, 0.2);
        st.phase = st.phase || 0;
        
        for (let i = 0; i < len; i++) {
          st.delayBuffer[st.idx] = data[i];
          
          const m = Math.sin(st.phase);
          let readIdx = st.idx - Math.round(1000 + m * 50 + sh);
          while (readIdx < 0) readIdx += st.size;
          
          data[i] = st.delayBuffer[readIdx];
          st.idx = (st.idx + 1) % st.size;
          st.phase += 2 * Math.PI * mf / sr;
          if (st.phase > 2 * Math.PI) st.phase -= 2 * Math.PI;
        }
        break;
      }
      case 'monster':
      case 'childVoice':
      case 'womanVoice':
      case 'girlVoice':
      case 'ladyVoice':
      case 'chipmunk':
      case 'deepVoice': {
        const st = this.getDelayBuffer(name, 0.1);
        let factor = 1;
        if (name === 'monster') factor = 1 - (value / 100) * 0.5;
        if (name === 'childVoice') factor = 1 + (value / 100) * 0.8;
        if (name === 'womanVoice') factor = 1 + (value / 100) * 0.35;
        if (name === 'girlVoice') factor = 1 + (value / 100) * 0.6;
        if (name === 'ladyVoice') factor = 1 + (value / 100) * 0.2;
        if (name === 'deepVoice') factor = 1 - (value / 100) * 0.4;
        if (name === 'chipmunk') factor = 1 + (value / 100) * 1.5;
        
        const windowSize = Math.floor(sr * 0.05); // 50ms window
        const phaseInc = (1 - factor) / windowSize;
        st.phase = st.phase || 0;
        
        const tmp = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          st.delayBuffer[st.idx] = data[i];
          
          st.phase += phaseInc;
          if (st.phase >= 1.0) st.phase -= 1.0;
          else if (st.phase < 0.0) st.phase += 1.0;
          
          const p1 = st.phase;
          const p2 = (st.phase + 0.5) % 1.0;
          
          const env1 = 1.0 - Math.abs(p1 - 0.5) * 2.0;
          const env2 = 1.0 - Math.abs(p2 - 0.5) * 2.0;
          
          const offset1 = p1 * windowSize;
          const offset2 = p2 * windowSize;
          
          const getSample = (offset) => {
            let readIdx = st.idx - offset;
            if (readIdx < 0) readIdx += st.size;
            const r1 = Math.floor(readIdx);
            const r2 = (r1 + 1) % st.size;
            const frac = readIdx - r1;
            return st.delayBuffer[r1] * (1 - frac) + st.delayBuffer[r2] * frac;
          };
          
          let s = getSample(offset1) * env1 + getSample(offset2) * env2;
          
          if (name === 'monster') s *= 1.3;
          if (name === 'childVoice') s *= 0.8;
          if (name === 'womanVoice') s *= 0.9;
          if (name === 'girlVoice') s *= 0.85;
          if (name === 'ladyVoice') s *= 0.95;
          if (name === 'chipmunk') s *= 0.7;
          if (name === 'deepVoice') {
            st.prev = 0.97 * (st.prev || 0) + 0.03 * s;
            s = s * 0.5 + st.prev * 1.5;
          }
          tmp[i] = s;
          st.idx = (st.idx + 1) % st.size;
        }
        data.set(tmp);
        break;
      }
      case 'hall':
      case 'cave':
      case 'stadium': {
        let delays = [];
        let dc = 0;
        let mix = 0;
        if (name === 'hall') {
          delays = [2963, 3857, 4219, 5433];
          dc = value / 200;
          mix = 0.7;
        } else if (name === 'cave') {
          delays = [1200, 2400, 3600, 4800, 6000];
          dc = value / 150;
          mix = 0.5;
        } else {
          delays = [5000, 10000, 15000, 20000, 25000];
          dc = value / 250;
          mix = 0.6;
        }
        
        const maxDelay = Math.max(...delays);
        const st = this.getDelayBuffer(name, maxDelay / sr + 0.1);
        
        for (let i = 0; i < len; i++) {
          let s = data[i] * mix;
          for (const dl of delays) {
            let readIdx = st.idx - dl;
            if (readIdx < 0) readIdx += st.size;
            s += st.delayBuffer[readIdx] * dc;
          }
          st.delayBuffer[st.idx] = data[i] + (s - data[i]) * 0.3;
          st.idx = (st.idx + 1) % st.size;
          data[i] = s;
        }
        break;
      }
      case 'autoTune': {
        const corr = value / 100;
        const st = this.getState(name);
        st.prev = st.prev || 0;
        for (let i = 0; i < len; i++) {
          const pitch = data[i] - st.prev;
          const step = 0.01;
          const corrected = Math.round(pitch / step) * step;
          data[i] = data[i] * (1 - corr) + corrected * corr;
          st.prev = data[i];
        }
        break;
      }
    }
  }
}

registerProcessor('voice-processor', VoiceProcessor);
