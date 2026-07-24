# VoiceEffect

Real-time voice effect processor built with Electron. Apply 22 voice effects, save presets, and route audio through virtual devices.

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

Output goes to `dist/`. Windows x64 only.

## Features

- Real-time mic input with live AudioWorklet processing
- 22 built-in voice effects with on/off toggles and 0-100% intensity sliders
- Presets system (save/load/delete effect combinations)
- Input/output device selection
- Per-device volume control
- Virtual audio adapter (VB-Cable) support with auto-install
- Dark/Light theme toggle
- System tray minimize with close-to-tray option
- Live input/output level meters with adjustable sensitivity
- CPU, RAM, latency, and uptime stats display
- Frameless window with custom titlebar
- Window position/size persistence across restarts
- Toast notifications for actions
- Auto-start audio on launch option

## Effects

| Group | Effects |
|-------|---------|
| Voice | Pitch, Formant |
| Dynamics | Compressor, Limiter |
| Tone | EQ, Bass Boost, Treble Boost |
| Space | Reverb, Echo, Hall, Cave, Stadium |
| Modulation | Chorus, AutoTune |
| Creative | Distortion, Radio, Telephone, Robot, Alien, Monster, Child, Deep, Chipmunk |

## Architecture

```
main.js               Electron main process (window, IPC, tray, settings, device enumeration)
preload.js            Context bridge - exposes safe API to renderer
audio-engine.js       Main process audio state, device enumeration, stats aggregation
virtual-audio-adapter.js  VB-Cable driver installer/uninstaller
create-icon.js        Programmatic PNG/ICO icon generator
public/
  index.html          Renderer UI + all client-side audio processing
  voice-processor.js  AudioWorklet DSP - runs all effects on a dedicated audio thread
data/
  icon.ico            Windows app icon
  icon.png            PNG app icon
presets/              Saved preset JSON files
```

### Audio Pipeline

```
Mic Stream (getUserMedia)
  -> MediaStreamSource
    -> InputGain
      -> AnalyserNode (input metering)
        -> AudioWorkletNode (voice-processor.js - effects processing)
          -> OutputGain
            -> AnalyserNode (output metering)
              -> AudioContext.destination (speakers or virtual device)
```

All audio DSP runs inside `AudioWorkletNode` on a dedicated audio thread, keeping the UI responsive. Effects are applied sequentially per audio buffer.

### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `start-audio` | Renderer -> Main | Start audio engine with config |
| `stop-audio` | Renderer -> Main | Stop audio engine |
| `get-audio-status` | Renderer -> Main | Get current engine state |
| `get-devices` | Renderer -> Main | Enumerate audio devices |
| `set-input-device` | Renderer -> Main | Switch input device |
| `set-output-device` | Renderer -> Main | Switch output device |
| `set-input-volume` | Renderer -> Main | Set mic volume (0-100) |
| `set-output-volume` | Renderer -> Main | Set output volume (0-100) |
| `set-effect` | Renderer -> Main | Update effect parameters |
| `toggle-effect` | Renderer -> Main | Enable/disable effect |
| `set-effects-chain` | Renderer -> Main | Set all effects at once |
| `update-audio-stats` | Renderer -> Main | Push processing stats |
| `get-settings` / `save-settings` | Renderer -> Main | Load/persist settings |
| `get-presets` | Renderer -> Main | List saved presets |
| `save-preset` / `delete-preset` | Renderer -> Main | Save/delete a preset |
| `get-system-stats` | Renderer -> Main | Request CPU/RAM data |
| `minimize-window` / `maximize-window` / `close-window` | Renderer -> Main | Window controls |
| `open-external` | Renderer -> Main | Open URL in system browser |
| `open-logs-folder` | Renderer -> Main | Open logs directory |
| `check-adapter-installed` | Renderer -> Main | Check VB-Cable status |
| `install-adapter` / `uninstall-adapter` | Renderer -> Main | Manage VB-Cable driver |
| `input-level` / `output-level` | Main -> Renderer | Level meter data |
| `system-stats` | Main -> Renderer | CPU/RAM/uptime updates |
| `adapter-status` / `adapter-installing` / `adapter-progress` | Main -> Renderer | Adapter state updates |
| `log-message` | Main -> Renderer | Forward log to console |

## Settings

Stored in `userData/settings.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| `sampleRate` | 44100 | Audio sample rate (22050/44100/48000) |
| `bufferSize` | 256 | Audio buffer size (128-2048) |
| `inputVolume` / `outputVolume` | 80 | Volume levels (0-100) |
| `theme` | "dark" | UI theme (dark/light) |
| `autoStart` | false | Auto-start audio on launch |
| `minimizeToTray` | true | Hide to tray on close |
| `showLatency` | true | Show latency in stats |
| `inputSensitivity` / `outputSensitivity` | 300/100 | Level meter sensitivity (50-600) |
| `windowBounds` | null | Saved window position/size |

## Presets

Presets save the current effect configuration as JSON files in `presets/`. Each preset stores which effects are enabled and their intensity values. Create, load, or delete presets from the Side Panel profile section.

## Tech Stack

- Electron 28
- Web Audio API (AudioWorkletNode)
- Vanilla HTML/CSS/JS (no frameworks)
- PowerShell (device enumeration)
- VB-Audio Virtual Cable (optional virtual audio routing)

## License

MIT
