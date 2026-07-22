# VoiceEffect

Real-time voice effect processor built with Electron. Apply voice effects, presets, and run audio through an ONNX-powered pipeline.

## Install & Run

```bash
npm install
npm start
```

## Building

```bash
npm run build          # Portable + NSIS installer
npm run build:portable # Portable only
npm run build:setup    # NSIS installer only
```

Output goes to `dist/`.

## Features

- Real-time mic input with live processing
- 22 built-in voice effects with adjustable intensity
- Presets system (save/load effect combinations)
- Input/output device selection
- Per-device volume control
- Dark/Light theme toggle
- System tray minimize
- ONNX model import (placeholder - inference pipeline not yet implemented)
- Live input/output level meters
- CPU, RAM, latency stats display

## Effects

| Group | Effects |
|-------|---------|
| Voice | Pitch, Formant |
| Space | Reverb, Echo, Hall, Cave, Stadium |
| Modulation | Chorus, AutoTune |
| Dynamics | Compressor, Limiter |
| Tone | EQ, Bass Boost, Treble Boost |
| Creative | Distortion, Radio, Telephone, Robot, Alien, Monster, Child, Deep, Chipmunk |

Each effect has an on/off toggle and a 0-100 intensity slider.

## Architecture

```
main.js           Electron main process (window, IPC, tray, settings persistence)
preload.js        Context bridge - exposes safe API to renderer
audio-engine.js   Main process audio state, device enumeration, model management
public/
  index.html      Renderer UI + all client-side audio processing (AudioWorkletNode)
  voice-processor.js   AudioWorklet - runs effects on a separate thread
  model-inference.js   ONNX model loader and inference engine (onnxruntime-web)
  ort-wasm-simd-threaded.wasm  ONNX Runtime WASM backend (12.8MB)
models/           ONNX model files (.onnx, .bin)
presets/          Saved preset JSON files
```

### Audio Pipeline

```
Mic Stream -> Input Gain -> Analyser -> AudioWorkletNode -> [MessagePort] -> Model Inference (ONNX) -> Output Gain -> Analyser -> Destination
                                     (voice-processor.js)                  (model-inference.js)
                                     (effects processing)                  (GTCRN/DeepFilterNet)
```

Audio processing uses `AudioWorkletNode` which runs on a dedicated audio thread, keeping the UI responsive. Effects are applied per-buffer inside the worklet processor. When a model is loaded, audio chunks are sent to the main thread for ONNX inference via `onnxruntime-web` (WASM), then the enhanced audio is sent back to the worklet.

### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `start-audio` | Renderer -> Main | Start audio engine |
| `stop-audio` | Renderer -> Main | Stop audio engine |
| `get-devices` | Renderer -> Main | Enumerate audio devices |
| `set-effect` | Renderer -> Main | Update effect parameters |
| `toggle-effect` | Renderer -> Main | Enable/disable effect |
| `get-settings` | Renderer -> Main | Load settings |
| `save-settings` | Renderer -> Main | Persist settings |
| `get-models` | Renderer -> Main | List imported models |
| `load-model` | Renderer -> Main | Load ONNX model |
| `system-stats` | Main -> Renderer | CPU/RAM updates |
| `input-level` | Main -> Renderer | Mic level data |
| `output-level` | Main -> Renderer | Output level data |

## Settings

Stored in `userData/settings.json`. Includes sample rate, buffer size, volume levels, selected devices, active effects, theme, and window position.

Default sample rate: 44100Hz. Default buffer size: 256.

## Models

The app supports importing `.onnx` and `.bin` model files through the UI or by placing them in the `models/` directory. Metadata (name, author, version, description) can be edited per model.

### Included Models

Two popular speech enhancement models are pre-installed:

**GTCRN (523KB)**
- Source: [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (13.6k GitHub stars)
- Purpose: Real-time speech denoising at 16kHz
- Architecture: Gated Temporal Convolutional Recurrent Network
- License: Apache-2.0
- File: `models/gtcrn_simple.onnx`

**DeepFilterNet3 (~8.5MB)**
- Source: [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (4.5k GitHub stars)
- Purpose: Speech enhancement at 48kHz using deep filtering
- Architecture: ERB encoder + deep filtering decoder (3 ONNX files)
- License: MIT / Apache-2.0
- Files: `models/deepfilternet3_enc.onnx`, `deepfilternet3_erb_dec.onnx`, `deepfilternet3_df_dec.onnx`

### How Model Inference Works

1. Load a model from the Models panel (click the play button)
2. The model runs via `onnxruntime-web` (WASM backend) in the renderer
3. Audio is routed: Microphone -> Effects (AudioWorklet) -> Model Inference (main thread) -> Output
4. GTCRN automatically resamples 44100Hz -> 16000Hz for inference

### Adding More Models

Place `.onnx` files in the `models/` directory. Supported types:
- Speech enhancement/denoising models
- Voice conversion models (RVC)

**Where to Find Voice Models**

Voice Conversion (RVC):
- https://huggingface.co/models?search=rvc+onnx
- https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI

Speech Enhancement:
- https://huggingface.co/models?search=speech+enhancement+onnx
- https://github.com/k2-fsa/sherpa-onnx/releases/tag/speech-enhancement-models

General Sources:
- https://huggingface.co/models?library=onnx
- https://onnxruntime.ai/models/

To make models functional, audio buffers need to be routed through the loaded `InferenceSession` in `audio-engine.js`.

## Presets

Presets save the current effect configuration (which effects are active and their values). Saved as JSON files in `presets/`. Create, load, or delete presets from the Presets modal.

## Tech Stack

- Electron 28
- Web Audio API (AudioWorkletNode)
- ONNX Runtime Node (optional, for model support)
- No external UI frameworks - vanilla HTML/CSS/JS

## License

MIT
