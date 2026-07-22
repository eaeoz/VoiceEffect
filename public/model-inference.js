class StreamingSTFT {
  constructor(nFft, hopLength, windowLength, windowType) {
    this.nFft = nFft;
    this.hopLength = hopLength;
    this.windowLength = windowLength;
    this.numBins = nFft / 2 + 1;
    this.pi2 = 2.0 * Math.PI;

    this.window = new Float32Array(windowLength);
    if (windowType === 'hann_sqrt' || windowType === 'sqrt_hann') {
      for (let i = 0; i < windowLength; i++) {
        this.window[i] = Math.sqrt(0.5 * (1.0 - Math.cos(this.pi2 * i / windowLength)));
      }
    } else {
      for (let i = 0; i < windowLength; i++) {
        this.window[i] = 0.5 * (1.0 - Math.cos(this.pi2 * i / windowLength));
      }
    }

    this.cosF = new Float32Array(this.numBins * nFft);
    this.sinF = new Float32Array(this.numBins * nFft);
    this.cosI = new Float32Array(nFft * this.numBins);
    this.sinI = new Float32Array(nFft * this.numBins);
    for (let k = 0; k < this.numBins; k++) {
      for (let n = 0; n < nFft; n++) {
        const angle = this.pi2 * k * n / nFft;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        this.cosF[k * nFft + n] = c;
        this.sinF[k * nFft + n] = s;
        this.cosI[n * this.numBins + k] = c;
        this.sinI[n * this.numBins + k] = s;
      }
    }

    this.analysisBuffer = new Float32Array(windowLength);
    this.overlapAddBuffer = new Float32Array(windowLength);
    this.fftInput = new Float32Array(windowLength);
    this.fftOutput = new Float32Array(2 * this.numBins);
    this.ifftOutput = new Float32Array(windowLength);
    this.started = false;
  }

  forwardDft(input, output) {
    for (let k = 0; k < this.numBins; k++) {
      let real = 0;
      let imag = 0;
      const base = k * this.nFft;
      for (let n = 0; n < this.nFft; n++) {
        const v = input[n];
        real += v * this.cosF[base + n];
        imag -= v * this.sinF[base + n];
      }
      output[2 * k] = real;
      output[2 * k + 1] = imag;
    }
  }

  inverseDft(input, output) {
    for (let n = 0; n < this.nFft; n++) {
      let sum = input[0];
      if (this.nFft % 2 === 0) {
        sum += input[2 * (this.numBins - 1)] * ((n & 1) ? -1.0 : 1.0);
      }
      const base = n * this.numBins;
      for (let k = 1; k < this.numBins - 1; k++) {
        const real = input[2 * k];
        const imag = input[2 * k + 1];
        sum += 2.0 * (real * this.cosI[base + k] - imag * this.sinI[base + k]);
      }
      output[n] = sum / this.nFft;
    }
  }

  processHop(hopSamples) {
    this.analysisBuffer.copyWithin(0, this.hopLength);
    this.analysisBuffer.set(hopSamples, this.windowLength - this.hopLength);

    for (let i = 0; i < this.windowLength; i++) {
      this.fftInput[i] = this.analysisBuffer[i] * this.window[i];
    }

    this.forwardDft(this.fftInput, this.fftOutput);
    return this.fftOutput;
  }

  processInverse(enhancedSpectrum, outputHop) {
    this.inverseDft(enhancedSpectrum, this.ifftOutput);

    this.overlapAddBuffer.copyWithin(0, this.hopLength);
    this.overlapAddBuffer.fill(0, this.windowLength - this.hopLength);

    for (let i = 0; i < this.windowLength; i++) {
      this.overlapAddBuffer[i] += this.ifftOutput[i] * this.window[i];
    }

    if (!this.started) {
      this.started = true;
      return false;
    }

    for (let i = 0; i < this.hopLength; i++) {
      outputHop[i] = this.overlapAddBuffer[i];
    }
    return true;
  }

  reset() {
    this.analysisBuffer.fill(0);
    this.overlapAddBuffer.fill(0);
    this.started = false;
  }
}

class ModelInference {
  constructor() {
    this.session = null;
    this.modelType = null;
    this.modelLoaded = false;
    this.targetSampleRate = 16000;
    this.inputSampleRate = 44100;
    this.frameSize = 256;

    this.stft = null;
    this.convCache = null;
    this.traCache = null;
    this.interCache = null;

    this.resampledBuffer = new Float32Array(0);
    this.outputBuffer16k = new Float32Array(0);
    this.outputBuffer44k = new Float32Array(0);
    this.pendingResample44k = new Float32Array(0);
    this.started = false;
  }

  async loadModel(modelPath, modelType) {
    try {
      const ort = window.ort;
      ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
      ort.env.wasm.wasmPaths = { 'ort-wasm simd-threaded': './ort-wasm-simd-threaded.wasm' };

      if (modelType === 'gtcrn') {
        this.session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        this.modelType = 'gtcrn';
        this.targetSampleRate = 16000;
        this.frameSize = 256;

        this.stft = new StreamingSTFT(512, 256, 512, 'hann_sqrt');
        this.convCache = new Float32Array(2 * 1 * 16 * 16 * 33);
        this.traCache = new Float32Array(2 * 3 * 1 * 1 * 16);
        this.interCache = new Float32Array(2 * 1 * 33 * 16);
      } else if (modelType === 'deepfilternet') {
        const basePath = modelPath.replace('deepfilternet3_enc.onnx', '');
        const [enc, erb, df] = await Promise.all([
          ort.InferenceSession.create(basePath + 'deepfilternet3_enc.onnx', { executionProviders: ['wasm'] }),
          ort.InferenceSession.create(basePath + 'deepfilternet3_erb_dec.onnx', { executionProviders: ['wasm'] }),
          ort.InferenceSession.create(basePath + 'deepfilternet3_df_dec.onnx', { executionProviders: ['wasm'] })
        ]);
        this.session = { enc, erb, df };
        this.modelType = 'deepfilternet';
        this.targetSampleRate = 48000;
      }

      this.modelLoaded = true;
      this.resampledBuffer = new Float32Array(0);
      this.outputBuffer16k = new Float32Array(0);
      this.outputBuffer44k = new Float32Array(0);
      this.pendingResample44k = new Float32Array(0);
      this.started = false;
      console.log('[Model] Loaded:', modelType);
      return true;
    } catch (e) {
      console.error('[Model] Load failed:', e);
      this.modelLoaded = false;
      return false;
    }
  }

  unloadModel() {
    this.session = null;
    this.modelType = null;
    this.modelLoaded = false;
    this.stft = null;
    this.convCache = null;
    this.traCache = null;
    this.interCache = null;
    this.resampledBuffer = new Float32Array(0);
    this.outputBuffer16k = new Float32Array(0);
    this.outputBuffer44k = new Float32Array(0);
    this.pendingResample44k = new Float32Array(0);
    this.started = false;
    console.log('[Model] Unloaded');
  }

  resample(input, fromRate, toRate) {
    if (fromRate === toRate) return new Float32Array(input);
    const ratio = fromRate / toRate;
    const outputLen = Math.floor(input.length / ratio);
    if (outputLen === 0) return new Float32Array(0);
    const output = new Float32Array(outputLen);
    for (let i = 0; i < outputLen; i++) {
      const srcIdx = i * ratio;
      const idx = Math.floor(srcIdx);
      const frac = srcIdx - idx;
      output[i] = input[idx] * (1 - frac) + ((idx + 1 < input.length) ? input[idx + 1] : 0) * frac;
    }
    return output;
  }

  async processGTCRN(inputFloat32) {
    if (!this.session || !this.modelLoaded) return inputFloat32;

    const ort = window.ort;
    const hopLength = 256;
    const numBins = 257;

    const resampled = this.resample(inputFloat32, this.inputSampleRate, this.targetSampleRate);

    const combined = new Float32Array(this.resampledBuffer.length + resampled.length);
    combined.set(this.resampledBuffer);
    combined.set(resampled, this.resampledBuffer.length);
    this.resampledBuffer = combined;

    while (this.resampledBuffer.length >= hopLength) {
      const frame = this.resampledBuffer.slice(0, hopLength);
      this.resampledBuffer = this.resampledBuffer.slice(hopLength);

      const spec = this.stft.processHop(frame);

      const mixData = new Float32Array(numBins * 2);
      for (let i = 0; i < numBins; i++) {
        mixData[2 * i] = spec[2 * i];
        mixData[2 * i + 1] = spec[2 * i + 1];
      }

      const mixTensor = new ort.Tensor('float32', mixData, [1, numBins, 1, 2]);
      const convCacheTensor = new ort.Tensor('float32', this.convCache, [2, 1, 16, 16, 33]);
      const traCacheTensor = new ort.Tensor('float32', this.traCache, [2, 3, 1, 1, 16]);
      const interCacheTensor = new ort.Tensor('float32', this.interCache, [2, 1, 33, 16]);

      const results = await this.session.run({
        mix: mixTensor,
        conv_cache: convCacheTensor,
        tra_cache: traCacheTensor,
        inter_cache: interCacheTensor
      });

      const enhData = results.enh.data;
      this.convCache = new Float32Array(results.conv_cache_out.data);
      this.traCache = new Float32Array(results.tra_cache_out.data);
      this.interCache = new Float32Array(results.inter_cache_out.data);

      const enhancedSpec = new Float32Array(numBins * 2);
      for (let i = 0; i < numBins * 2; i++) {
        enhancedSpec[i] = enhData[i];
      }

      const hopOutput = new Float32Array(hopLength);
      const hasOutput = this.stft.processInverse(enhancedSpec, hopOutput);
      if (hasOutput) {
        const newOut = new Float32Array(this.outputBuffer16k.length + hopLength);
        newOut.set(this.outputBuffer16k);
        newOut.set(hopOutput, this.outputBuffer16k.length);
        this.outputBuffer16k = newOut;
      }
    }

    if (this.outputBuffer16k.length === 0) {
      return new Float32Array(inputFloat32.length);
    }

    const out16k = this.outputBuffer16k;
    this.outputBuffer16k = new Float32Array(0);

    let out44k = this.resample(out16k, this.targetSampleRate, this.inputSampleRate);

    if (this.pendingResample44k.length > 0) {
      const combined = new Float32Array(this.pendingResample44k.length + out44k.length);
      combined.set(this.pendingResample44k);
      combined.set(out44k, this.pendingResample44k.length);
      out44k = combined;
      this.pendingResample44k = new Float32Array(0);
    }

    const desiredLen = inputFloat32.length;
    const result = new Float32Array(desiredLen);
    if (out44k.length >= desiredLen) {
      result.set(out44k.subarray(0, desiredLen));
      if (out44k.length > desiredLen) {
        this.pendingResample44k = out44k.slice(desiredLen);
      }
    } else {
      result.set(out44k);
    }

    return result;
  }

  async processDeepFilterNet(inputFloat32) {
    if (!this.session || !this.modelLoaded) return inputFloat32;
    return inputFloat32;
  }

  async process(inputFloat32) {
    if (!this.modelLoaded) return inputFloat32;
    if (this.modelType === 'gtcrn') return this.processGTCRN(inputFloat32);
    if (this.modelType === 'deepfilternet') return this.processDeepFilterNet(inputFloat32);
    return inputFloat32;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModelInference;
} else {
  window.ModelInference = ModelInference;
}
