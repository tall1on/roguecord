# System Audio Loopback — Design Specification

**Status:** Locked spec. This document is the authoritative plan for implementing WASAPI system-audio loopback capture in RogueCord via a Tauri v2 desktop shell. Code authors implementing this feature MUST follow this document verbatim: versions are pinned, file paths are fixed, type signatures are normative, event/channel names are final.

**Scope:** Windows-only capture (WASAPI loopback). macOS/Linux are stubs returning `Unsupported`. This spec covers Tauri v2 scaffolding, Rust plugin, TS client bridge, mediasoup integration, and UI hook-point.

**Decision baseline (from task brief, not re-opened):**
- **A2** — Rust (Tauri backend) performs WASAPI loopback capture AND Opus encoding.
- **B2** — Encoded Opus frames are transported to JS over Tauri IPC; JS decodes (WASM) → Float32 PCM → `MediaStreamTrackGenerator` → `MediaStreamTrack` → mediasoup Producer.
- A **separate additional** audio producer with `appData.source = 'system-audio'`. Does NOT touch any `getDisplayMedia` audio track.
- Full Tauri v2 scaffolding under [`client/src-tauri/`](../client/src-tauri/). (Note: [`client/package.json`](../client/package.json:10) already has `tauri:dev`/`tauri:build` script placeholders and Tauri v2 CLI/API deps installed — the crate root does not yet exist and must be created.)

---

## 1. Overview & Data-Flow Diagram

### 1.1 Conceptual pipeline

```
+-----------------------------------------------------------------------------+
| Windows OS                                                                  |
|                                                                             |
|   [Render endpoint audio engine]                                            |
|            |                                                                |
|            | WASAPI loopback (shared mode, event-driven)                    |
|            v                                                                |
|   +--------------------------+                                              |
|   | Rust capture thread       |   (wasapi crate, real-time priority)        |
|   |  - AudioClient loopback   |                                             |
|   |  - reads f32/i16 frames   |                                             |
|   +----------+----------------+                                             |
|              |                                                              |
|              | push (SPSC, bounded)                                         |
|              v                                                              |
|   +--------------------------+                                              |
|   | Lock-free ring buffer     |   ringbuf 0.4, capacity = 200 ms @ 48 kHz   |
|   | (raw device-rate PCM)     |   drop-oldest on overflow                   |
|   +----------+----------------+                                             |
|              |                                                              |
|              v                                                              |
|   +--------------------------+                                              |
|   | Resampler worker          |   rubato 0.15 (FftFixedIn)                  |
|   |  device SR  -> 48 000 Hz  |   stereo planar                             |
|   |  channels   -> 2 (stereo) |                                             |
|   +----------+----------------+                                             |
|              |                                                              |
|              v                                                              |
|   +--------------------------+                                              |
|   | Opus encoder worker       |   audiopus 0.3 (static libopus)             |
|   |  20 ms frames @ 48 kHz/2  |   VBR, fec=true, app=Audio                  |
|   +----------+----------------+                                             |
|              |                                                              |
|              | tauri::ipc::Channel<InvokeResponseBody::Raw(Vec<u8>)>        |
|              v                                                              |
+--------------|--------------------------------------------------------------+
               |  (binary IPC; NO JSON encoding of payload)
               v
+-----------------------------------------------------------------------------+
| WebView2 (Chromium / JS)                                                    |
|                                                                             |
|   +--------------------------+                                              |
|   | tauriBridge.ts            |   parses 16-byte ALF1 header                |
|   | Channel<Uint8Array>       |   extracts Opus packet + seq + ts_us        |
|   +----------+----------------+                                             |
|              |                                                              |
|              | postMessage(transfer=[buf])                                   |
|              v                                                              |
|   +--------------------------+                                              |
|   | decoder.worker.ts         |   @wasm-audio-decoders/opus                 |
|   |  Opus -> Float32 planar   |   sampleRate = 48 000, channels = 2         |
|   +----------+----------------+                                             |
|              |                                                              |
|              | postMessage(channelData[2], transfer=[2 ArrayBuffers])       |
|              v                                                              |
|   +--------------------------+                                              |
|   | trackGenerator.ts         |   AudioData({format:'f32-planar',...})      |
|   | MediaStreamTrackGenerator |   writer.write(audioData)                   |
|   +----------+----------------+                                             |
|              |                                                              |
|              v                                                              |
|   MediaStreamTrack (kind='audio', label='roguecord-system-audio')           |
|              |                                                              |
|              v                                                              |
|   webrtc.ts : sendTransport.produce({ track, appData:{source:'system-audio'}})|
+--------------|--------------------------------------------------------------+
               |
               v
+-----------------------------------------------------------------------------+
| Node.js server (server/src/ws/handlers.ts, server/src/mediasoup.ts)         |
|   mediasoup SFU  -> Opus RTP forwarded to consumers                         |
+-----------------------------------------------------------------------------+
               |
               v
     Remote peers consume & play as a second audio track (tagged system-audio)
```

### 1.2 Fixed operating parameters

| Parameter | Value |
| --- | --- |
| Capture API | WASAPI shared-mode loopback, event-driven |
| Internal PCM format | `f32` interleaved (native endpoint) then `f32` planar post-resample |
| Target sample rate | 48 000 Hz |
| Target channel count | 2 (stereo; downmix from 5.1/7.1, upmix from mono) |
| Opus frame duration | 20 ms (default; 2.5/5/10/20/40/60 allowed) |
| Opus bitrate | 128 000 bps default, range 32 000–510 000 |
| Opus complexity | 10 (default, range 0–10) |
| Opus application | `AUDIO` (not VOIP — we are carrying music) |
| Opus FEC | enabled |
| Opus DTX | disabled (we want continuous silence to mark "nothing playing") |
| Ring buffer capacity | 200 ms of device-rate stereo f32 |
| Sessions | **One concurrent session per app instance** |

### 1.3 Double-encode acknowledgement

Because mediasoup is an SFU over RTP with Opus codec negotiation and the W3C `RTCPeerConnection` owns encoding of outgoing `MediaStreamTrack`s, our pipeline does:

```
Rust(PCM->Opus)  ->  JS(Opus->PCM)  ->  WebRTC stack(PCM->Opus)  ->  RTP
```

This is an explicit, accepted inefficiency. Rationale: we encode in Rust solely to (a) minimize IPC throughput (~16 kB/s vs ~384 kB/s raw f32 stereo 48k) and (b) pave the way for a future optimization using `RTCRtpScriptTransform` / `Encoded Transform` to inject our Opus packets directly into the RTP sender without re-encoding — explicitly **out of scope** now, recorded here as a forward-looking path.

---

## 2. Tauri v2 Scaffold Plan

### 2.1 Directory tree

Create the following under [`client/src-tauri/`](../client/src-tauri/):

```
client/src-tauri/
├── .gitignore                              # "target/", "gen/"
├── build.rs                                # tauri_build::build()
├── Cargo.toml                              # workspace root (binary crate)
├── Cargo.lock                              # committed for reproducible builds
├── tauri.conf.json
├── icons/
│   ├── 32x32.png
│   ├── 128x128.png
│   ├── 128x128@2x.png
│   ├── icon.icns                           # placeholder (mac stub)
│   ├── icon.ico                            # Windows
│   └── icon.png
├── capabilities/
│   └── default.json                        # ACL for main window
├── src/
│   ├── main.rs                             # thin: calls roguecord_lib::run()
│   └── lib.rs                              # tauri::Builder::default()...
└── crates/
    └── tauri-plugin-audio-loopback/        # sub-crate (path dependency)
        ├── Cargo.toml
        ├── build.rs                        # tauri_plugin::Builder::new(...).build()
        ├── permissions/
        │   ├── default.toml
        │   ├── allow-list-devices.toml
        │   ├── allow-start.toml
        │   ├── allow-stop.toml
        │   └── allow-stats.toml
        └── src/
            ├── lib.rs                      # plugin entrypoint, init()
            ├── commands.rs                 # #[tauri::command] fns
            ├── capture.rs                  # WASAPI loopback (win), cfg-gated
            ├── resample.rs                 # rubato wrapper
            ├── encode.rs                   # Opus encoder wrapper
            ├── session.rs                  # SessionManager, state machine
            ├── error.rs                    # thiserror enum
            └── types.rs                    # DeviceInfo, StartOpts, FrameMessage...
```

File-length budget: every `.rs` file above must stay under 400 lines (hard). If `capture.rs` approaches that, split into `capture/mod.rs` + `capture/windows.rs` + `capture/stub.rs`.

### 2.2 `tauri.conf.json` (normative)

Path: [`client/src-tauri/tauri.conf.json`](../client/src-tauri/tauri.conf.json:1)

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "RogueCord",
  "version": "0.1.0",
  "identifier": "io.roguecord.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": false,
    "windows": [
      {
        "label": "main",
        "title": "RogueCord",
        "width": 1280,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "decorations": true
      }
    ],
    "security": {
      "csp": "default-src 'self' ipc: http://ipc.localhost; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: mediastream:; connect-src 'self' ipc: http://ipc.localhost ws: wss: https:; worker-src 'self' blob:; child-src 'self' blob:"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ],
    "windows": {
      "webviewInstallMode": { "type": "embedBootstrapper" }
    }
  },
  "plugins": {}
}
```

Notes:
- `withGlobalTauri: false` — we import everything via `@tauri-apps/api` (already in [`client/package.json`](../client/package.json:15)).
- CSP allows `wasm-unsafe-eval` (required by `@wasm-audio-decoders/opus`), `mediastream:` media-src (needed for `MediaStreamTrackGenerator` streams), `blob:` worker-src (for the decoder worker), and `ipc:` for Tauri's binary IPC channel.
- **No** permissions for camera/microphone are declared — system-audio loopback does NOT go through `getUserMedia`.

### 2.3 Vite integration

[`client/vite.config.ts`](../client/vite.config.ts:1) — apply this exact diff (most knobs already present; confirm and add HMR block):

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const host = process.env.TAURI_DEV_HOST

export default defineConfig(async () => ({
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_DEBUG ? false : 'oxc',
    sourcemap: !!process.env.TAURI_DEBUG
  },
  plugins: [vue(), /* existing emoji-cache-headers plugin retained verbatim */]
}))
```

Preserve the existing `roguecord-emoji-cache-headers` plugin unchanged.

[`client/package.json`](../client/package.json:1) — scripts (already present; keep):

```json
"scripts": {
  "dev": "vite",
  "build": "vue-tsc -b && vite build",
  "preview": "vite preview",
  "tauri": "tauri",
  "tauri:dev": "tauri dev",
  "tauri:build": "tauri build"
}
```

Add one new dependency (decoder; see §4.1):

```json
"dependencies": {
  "@wasm-audio-decoders/opus": "0.8.6"
}
```

### 2.4 Capabilities / ACL

Path: [`client/src-tauri/capabilities/default.json`](../client/src-tauri/capabilities/default.json:1)

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default permissions for the main window.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:window:default",
    "core:webview:default",
    "audio-loopback:default"
  ]
}
```

Plugin-side permission files (bundled in the sub-crate's `permissions/` directory and referenced by `tauri_plugin::Builder` in its `build.rs`):

`crates/tauri-plugin-audio-loopback/permissions/default.toml`
```toml
"$schema" = "schemas/schema.json"

[default]
description = "Default permissions for the audio-loopback plugin. Allows all user commands."
permissions = [
    "allow-list-devices",
    "allow-start",
    "allow-stop",
    "allow-stats",
]
```

`allow-list-devices.toml`
```toml
[[permission]]
identifier = "allow-list-devices"
description = "Enumerate audio render endpoints."
commands.allow = ["audio_loopback_list_devices"]
```

`allow-start.toml`, `allow-stop.toml`, `allow-stats.toml` — same pattern, one command each: `audio_loopback_start`, `audio_loopback_stop`, `audio_loopback_stats`.

### 2.5 Plugin-as-sub-crate vs inline module — DECISION: sub-crate

**Chosen: sub-crate at `client/src-tauri/crates/tauri-plugin-audio-loopback/`** referenced by the shell crate as a `path = "crates/tauri-plugin-audio-loopback"` dependency.

Justification:
1. Keeps `src/lib.rs` in the shell crate to ~30 lines (just `Builder::default().plugin(tauri_plugin_audio_loopback::init()).run(...)`).
2. Independent `Cargo.toml` allows pinning audio deps (wasapi, audiopus, rubato) without polluting the shell crate's feature graph.
3. Enables cfg-gated Windows-only compilation of heavyweight deps (all wrapped in `[target.'cfg(windows)'.dependencies]`) without polluting every Tauri build.
4. Reusable across any future Tauri app in this monorepo (matches the `tauri-plugin-*` ecosystem pattern).
5. Ships its own `permissions/` directory, the canonical Tauri v2 plugin layout.

---

## 3. Rust Plugin Spec — `tauri-plugin-audio-loopback`

### 3.1 `Cargo.toml` (sub-crate)

Path: [`client/src-tauri/crates/tauri-plugin-audio-loopback/Cargo.toml`](../client/src-tauri/crates/tauri-plugin-audio-loopback/Cargo.toml:1)

```toml
[package]
name = "tauri-plugin-audio-loopback"
version = "0.1.0"
edition = "2021"
rust-version = "1.77"
description = "WASAPI system-audio loopback capture + Opus encoding plugin for Tauri v2."
license = "MIT OR Apache-2.0"

[build-dependencies]
tauri-plugin = { version = "2.3", features = ["build"] }

[dependencies]
tauri        = { version = "2.3", features = [] }
serde        = { version = "1.0.219", features = ["derive"] }
serde_json   = "1.0.140"
thiserror    = "1.0.69"
tracing      = "0.1.41"
parking_lot  = "0.12.3"
ringbuf      = "0.4.7"
rubato       = "0.15.0"
audiopus     = "0.3.0-rc.0"
once_cell    = "1.20.2"
crossbeam-channel = "0.5.13"

[target.'cfg(windows)'.dependencies]
wasapi       = "0.17.0"
windows      = { version = "0.58.0", features = [
    "Win32_Foundation",
    "Win32_Media_Audio",
    "Win32_System_Com",
    "Win32_System_Threading"
]}

[features]
default = []
```

Runtime: capture and encode workers run on **OS threads** (`std::thread::spawn`) — not Tokio. We do not pull in tokio; Tauri's own runtime handles command futures, and our plugin's only async touchpoint is `#[tauri::command]` signatures (which may be sync). Justification: WASAPI event-driven capture needs bounded-latency blocking calls; async executors complicate RT behaviour for zero benefit.

### 3.2 Crate choice — `wasapi` (not `cpal`)

**Chosen: `wasapi = "0.17"`.**

Rationale:
- Direct, typed bindings over `IAudioClient` / `IAudioCaptureClient` / `IMMDeviceEnumerator` with no cross-platform abstraction. We explicitly want Windows-only and need access to the loopback flag (`AUDCLNT_STREAMFLAGS_LOOPBACK`) against an explicit `IMMDevice` — choice-by-id is a first-class operation in `wasapi`.
- Event-driven loopback (`SetEventHandle` + `WaitForSingleObject`) is a supported pattern in `wasapi` and delivers lower, more predictable latency than cpal's polling-style stream callback.
- `wasapi::DeviceCollection` allows enumerating **render** endpoints (loopback targets) independent of `default_output_device`; cpal exposes loopback only via `Host::default_output_device` on 0.15+, which is insufficient for letting the user pick a specific endpoint (e.g. a secondary HDMI monitor).
- Avoids cpal's pulled-in ALSA/CoreAudio/WASAPI multi-platform baggage on a Windows-only code path.
- `wasapi` 0.17 is actively maintained (current with `windows` 0.58), pure Rust over the `windows` crate.

Trade-off acknowledgement: cross-platform stubs for macOS/Linux must live behind `cfg(not(windows))` in `capture.rs` and return `Error::Unsupported`. This is acceptable; we are shipping Windows-first.

### 3.3 Opus crate choice — `audiopus` (not `opus`)

**Chosen: `audiopus = "0.3.0-rc.0"`** (with its companion `audiopus_sys` that vendors & builds libopus from source via cmake, fully statically linked).

Rationale:
- `audiopus_sys` ships libopus sources in-tree and builds them with cmake; **no system `libopus` dependency**, which matches our "no external deps" preference for a redistributable MSI/NSIS.
- Strong typed API (`SampleRate::Hz48000`, `Channels::Stereo`, `Application::Audio`) — safer than the thin FFI in the `opus` crate.
- `audiopus` is the de-facto crate used by voice projects (Serenity/Songbird historically). The `0.3.0-rc.0` tag is stable-in-practice and what published crates in the ecosystem currently pin.

Note: `opus = "0.3"` by the `opus-rs` org also statically links libopus via `opusic-sys`. It is a viable fallback **only** if `audiopus_sys` fails to build on the developer's MSVC toolchain; in that case switch crates with identical semantics. Do not mix: pick one at initial commit.

### 3.4 Public API — Tauri commands

Defined in `commands.rs`:

```rust
// types.rs
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub id: String,          // IMMDevice id string (endpoint id, e.g. "{0.0.0.00000000}.{...}")
    pub name: String,        // friendly name, e.g. "Speakers (Realtek High Definition Audio)"
    pub is_default_output: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct StartOpts {
    pub device_id: Option<String>,   // None => default render endpoint
    #[serde(default = "default_bitrate")] pub bitrate_bps: u32,     // 128000
    #[serde(default = "default_frame_ms")] pub frame_duration_ms: u8, // 20
    #[serde(default = "default_complexity")] pub complexity: u8,    // 10
    #[serde(default = "default_channels")] pub channels: u8,        // 2
}
fn default_bitrate() -> u32 { 128_000 }
fn default_frame_ms() -> u8 { 20 }
fn default_complexity() -> u8 { 10 }
fn default_channels() -> u8 { 2 }

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct SessionId(pub u32);

#[derive(Debug, Clone, serde::Serialize)]
pub struct Stats {
    pub session: SessionId,
    pub frames_emitted: u64,
    pub frames_dropped_ring_overflow: u64,
    pub frames_dropped_channel_full: u64,
    pub encoder_latency_us_p50: u32,
    pub encoder_latency_us_p99: u32,
    pub capture_device_sample_rate: u32,
    pub capture_device_channels: u16,
    pub started_at_unix_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum StateMessage {
    Started { session: SessionId, device_id: String, device_name: String, device_sample_rate: u32, device_channels: u16 },
    Stopped { session: SessionId, reason: String },
    Error   { session: SessionId, error: String },
}
```

Commands (exact signatures):

```rust
#[tauri::command]
pub async fn audio_loopback_list_devices() -> Result<Vec<DeviceInfo>, Error>;

#[tauri::command]
pub async fn audio_loopback_start(
    app: tauri::AppHandle,
    opts: StartOpts,
    frames: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>, // binary frames
    state: tauri::ipc::Channel<StateMessage>,                    // JSON state msgs
    session_mgr: tauri::State<'_, std::sync::Arc<SessionManager>>,
) -> Result<SessionId, Error>;

#[tauri::command]
pub async fn audio_loopback_stop(
    session: SessionId,
    session_mgr: tauri::State<'_, std::sync::Arc<SessionManager>>,
) -> Result<(), Error>;

#[tauri::command]
pub async fn audio_loopback_stats(
    session: SessionId,
    session_mgr: tauri::State<'_, std::sync::Arc<SessionManager>>,
) -> Result<Stats, Error>;
```

**IPC transport: `tauri::ipc::Channel` (NOT `app.emit`).**

The `frames` channel carries raw binary (`Vec<u8>`) via `Channel::send(InvokeResponseBody::Raw(bytes))`. Tauri v2 channels are the idiomatic, zero-JSON-encoding path for high-throughput binary streams. Events (`app.emit`) would JSON-encode every payload as a base64/array — unacceptable for ~100 frames/sec.

The `state` channel is JSON-typed (`Channel<StateMessage>`) for human-readable lifecycle events and errors.

### 3.5 Binary frame format — `ALF1`

Every emitted frame on the `frames` channel is a single `Vec<u8>` of length `16 + opus_packet_len`. Header is 16 bytes little-endian:

```
offset  size  field
------  ----  -----
0        4    magic         = b"ALF1"                         (ASCII literal)
4        4    session_id    = u32 LE                          (matches the SessionId returned by start)
8        4    seq           = u32 LE                          (monotonic from 0, wraps mod 2^32)
12       4    timestamp_us  = u32 LE                          (capture monotonic clock, wraps mod 2^32 ~71 min)
16       N    opus_packet   = raw Opus TOC+payload bytes
```

The 32-bit wrap of `timestamp_us` is acceptable: JS side uses it as a relative reference vs the first frame; mediasoup publishes its own RTP timestamps downstream. No absolute wall-clock dependency.

### 3.6 Threading model

```
[OS Thread: "alf-capture"] (THREAD_PRIORITY_TIME_CRITICAL)
  wasapi IAudioCaptureClient::GetBuffer -> copy f32 interleaved frames
     |
     v producer side of SPSC HeapRb<f32> (200 ms capacity, stereo-device-rate)
[OS Thread: "alf-encode"]
  consumer side -> rubato FftFixedIn -> f32-planar stereo @ 48 kHz
     -> accumulate to frame_duration_ms samples per channel
     -> audiopus::coder::Encoder::encode_float(planar_interleaved_slice, &mut packet)
     -> build ALF1 header
     -> frames_channel.send(InvokeResponseBody::Raw(bytes))
```

**Backpressure policy:**
- Ring buffer full (capture side overruns encoder): **drop the oldest samples equivalent to the incoming chunk size**, increment `frames_dropped_ring_overflow`, log once per second at `tracing::warn` with a rate-limited span.
- Tauri channel send failure (frontend hasn't attached or disconnected): best-effort — log once, continue. Channel has its own internal unbounded queue server-side; if downstream JS lags, Chromium's IPC layer will buffer. We do NOT implement explicit channel backpressure in v1.

**Shutdown:**
- Explicit: `audio_loopback_stop(session_id)` flips `Session::stop_flag` (`parking_lot::AtomicBool`). Capture thread checks each iteration; encoder checks each drain. Both threads `join()` with a 2-second timeout; on timeout, log and detach.
- Implicit on window close: plugin registers an `on_window_event` handler in `init()` that stops all active sessions when the main window's `CloseRequested` event fires.
- App exit: `Drop for SessionManager` calls `stop_all()`.

**Concurrency policy: exactly ONE active session.** `audio_loopback_start` returns `Error::AlreadyRunning` if a session is already active. Justification: WASAPI loopback against a given endpoint is effectively single-consumer-within-process and the UI has one global toggle.

### 3.7 Error type

```rust
// error.rs
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum Error {
    #[error("audio-loopback is not supported on this platform")]
    Unsupported,
    #[error("a loopback session is already running")]
    AlreadyRunning,
    #[error("no loopback session with id {0:?}")]
    UnknownSession(SessionId),
    #[error("no default render endpoint")]
    NoDefaultDevice,
    #[error("device not found: {0}")]
    DeviceNotFound(String),
    #[error("WASAPI error: {0}")]
    Wasapi(String),
    #[error("resampler error: {0}")]
    Resample(String),
    #[error("opus encoder error: {0}")]
    Opus(String),
    #[error("invalid option: {0}")]
    InvalidOption(String),
    #[error("internal error: {0}")]
    Internal(String),
}
```

All `Result<T, Error>` returns are serialized directly; the `#[serde(tag = "kind", content = "message")]` gives JS a stable discriminant.

### 3.8 File-level responsibilities

| File | Responsibility | Hard line budget |
| --- | --- | --- |
| `lib.rs` | `pub fn init<R: Runtime>() -> TauriPlugin<R>`; registers commands + `SessionManager` state + window-close hook. | 80 |
| `commands.rs` | All `#[tauri::command]` fns; thin wrappers calling `SessionManager`. | 200 |
| `capture.rs` | `cfg(windows)` WASAPI capture thread; `cfg(not(windows))` stub returning `Unsupported`. | 380 |
| `resample.rs` | Stereo downmix + rubato `FftFixedIn` wrapper producing f32-planar 48 kHz frames of exact length. | 200 |
| `encode.rs` | audiopus `Encoder` wrapper; owns ALF1 header writer; maintains `seq`/`timestamp_us`. | 200 |
| `session.rs` | `SessionManager` (`parking_lot::Mutex<Option<Session>>`); spawns threads; exposes `start/stop/stats`. | 300 |
| `error.rs` | `Error` enum. | 80 |
| `types.rs` | Public DTOs. | 120 |

### 3.9 Shell crate — `Cargo.toml` and `src/*`

[`client/src-tauri/Cargo.toml`](../client/src-tauri/Cargo.toml:1):

```toml
[package]
name = "roguecord"
version = "0.1.0"
edition = "2021"
rust-version = "1.77"

[lib]
name = "roguecord_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.3", features = [] }

[dependencies]
tauri = { version = "2.3", features = [] }
serde = { version = "1.0.219", features = ["derive"] }
serde_json = "1.0.140"
tauri-plugin-audio-loopback = { path = "crates/tauri-plugin-audio-loopback" }

[profile.release]
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

[`client/src-tauri/src/main.rs`](../client/src-tauri/src/main.rs:1):

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    roguecord_lib::run();
}
```

[`client/src-tauri/src/lib.rs`](../client/src-tauri/src/lib.rs:1):

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_audio_loopback::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

[`client/src-tauri/build.rs`](../client/src-tauri/build.rs:1):

```rust
fn main() {
    tauri_build::build()
}
```

---

## 4. Client-Side TypeScript Spec

### 4.1 Opus decoder — `@wasm-audio-decoders/opus`

**Chosen: `@wasm-audio-decoders/opus@0.8.6`** (pin exact).

Comparison:
| Candidate | Decision |
| --- | --- |
| `@wasm-audio-decoders/opus` | ✅ Chosen. Actively maintained (2024). Ships a ready-to-use Web Worker build, f32-planar output, multi-channel (up to 8), no SharedArrayBuffer required, WASM compiled from libopus 1.5. |
| `opus-decoder` (same author, older package) | ❌ Superseded; same functionality, kept for compat only. |
| `libopus.js` | ❌ Not maintained since 2017; mono-focused; emscripten pre-WebAssembly era. |

Install:
```bash
npm install --save-exact @wasm-audio-decoders/opus@0.8.6
```

The library exposes `OpusDecoderWebWorker` which spins its own worker internally. We still wrap it in OUR decoder worker (§4.3) to decouple the bridge from decode work and allow cancellation/restart without leaking the internal worker. The library's worker is nested inside ours — acceptable overhead.

### 4.2 Module layout

All new files live under [`client/src/audio/systemLoopback/`](../client/src/audio/systemLoopback/). Everything imported via dynamic `import()` from call-sites (AGENTS.md rule).

```
client/src/audio/systemLoopback/
├── index.ts                 # public API, ≤ 120 lines
├── tauriBridge.ts           # Tauri Channel binding + ALF1 parsing, ≤ 200 lines
├── decoder.worker.ts        # Web Worker: wraps @wasm-audio-decoders/opus, ≤ 180 lines
├── trackGenerator.ts        # MediaStreamTrackGenerator wrapper, ≤ 180 lines
├── featureDetect.ts         # environment checks, ≤ 80 lines
└── types.ts                 # shared TS types, ≤ 80 lines
```

### 4.3 `types.ts`

```ts
export type SystemLoopbackDeviceInfo = {
  id: string;
  name: string;
  isDefaultOutput: boolean;
};

export type SystemLoopbackStartOpts = {
  deviceId?: string;
  bitrateBps?: number;      // default 128000
  frameDurationMs?: 2.5 | 5 | 10 | 20 | 40 | 60; // default 20
  complexity?: number;      // 0..10, default 10
};

export type SystemLoopbackHandle = {
  sessionId: number;
  track: MediaStreamTrack;
  stream: MediaStream;              // convenience (track wrapped in a MediaStream)
  stop: () => Promise<void>;
  onStateChange: (cb: (s: SystemLoopbackState) => void) => () => void;
};

export type SystemLoopbackState =
  | { state: 'started'; deviceId: string; deviceName: string; deviceSampleRate: number; deviceChannels: number }
  | { state: 'stopped'; reason: string }
  | { state: 'error';   error: string };

export type DecoderInboundMsg =
  | { type: 'init'; channels: 2; sampleRate: 48000 }
  | { type: 'packet'; opus: ArrayBuffer; seq: number; timestampUs: number }
  | { type: 'flush' }
  | { type: 'close' };

export type DecoderOutboundMsg =
  | { type: 'ready' }
  | { type: 'frame'; channelData: Float32Array[]; seq: number; timestampUs: number }
  | { type: 'error'; error: string };
```

### 4.4 `featureDetect.ts`

```ts
export function ensureTauriEnv(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) {
    throw new Error('[system-audio] Tauri runtime not detected. This feature requires the Tauri desktop build.');
  }
}

export function ensureInsertableStreams(): void {
  if (typeof (globalThis as any).MediaStreamTrackGenerator !== 'function') {
    throw new Error('[system-audio] MediaStreamTrackGenerator is unavailable. Requires Chromium-based WebView with Insertable Streams.');
  }
  if (typeof (globalThis as any).AudioData !== 'function') {
    throw new Error('[system-audio] AudioData (WebCodecs) is unavailable.');
  }
}
```

Called at the top of `startSystemAudioLoopback` before any dynamic import fires.

### 4.5 `tauriBridge.ts`

Responsibilities:
- Dynamic-import `@tauri-apps/api/core` to get `invoke` and `Channel`.
- Instantiate two channels: `framesChannel` (consumes `Uint8Array`/`ArrayBuffer`), `stateChannel` (consumes `SystemLoopbackState`).
- Wire `framesChannel.onmessage = (raw) => parseAlf1(raw)` → forwards `{opus, seq, timestampUs}` to the decoder worker via `postMessage`/transferable.
- Call `invoke('plugin:audio-loopback|audio_loopback_start', { opts, frames: framesChannel, state: stateChannel })`.
- Provide `listDevices()` and `stop(sessionId)`.

Key detail — parsing the ALF1 header:

```ts
const MAGIC = 0x31464c41; // 'ALF1' little-endian -> LE u32 when read as LE

function parseAlf1(buf: ArrayBuffer): { opus: ArrayBuffer; seq: number; timestampUs: number } | null {
  if (buf.byteLength < 16) return null;
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) return null;
  // session_id at offset 4 — verified in tauriBridge against the active session
  const seq = dv.getUint32(8, true);
  const timestampUs = dv.getUint32(12, true);
  const opus = buf.slice(16);
  return { opus, seq, timestampUs };
}
```

Tauri channels deliver bytes as `ArrayBuffer` when the server sends `InvokeResponseBody::Raw`. Channel callback signature: `(message: ArrayBuffer) => void`. We transfer `opus` into the decoder worker (`postMessage({...}, [opus])`).

### 4.6 `decoder.worker.ts`

- On `init`, dynamically import `@wasm-audio-decoders/opus` and construct `OpusDecoderWebWorker({ channels: 2, sampleRate: 48000, forceStereo: true })`. Wait for `.ready`.
- On each `packet`, call `decoder.decodeFrame(new Uint8Array(opus))` → `{ channelData: Float32Array[], samplesDecoded, sampleRate }`.
- Post `{ type: 'frame', channelData, seq, timestampUs }` back to main thread, transferring each `Float32Array.buffer`.
- On `flush`, call `decoder.flush()` if any packets pending.
- On `close`, `await decoder.free()` and `close()` the worker.

All errors caught and posted as `{ type: 'error', error: string }`.

### 4.7 `trackGenerator.ts`

Central TS — exact `AudioData` construction:

```ts
const SAMPLE_RATE = 48_000;
const NUM_CHANNELS = 2;

type TrackGenOpts = {
  frameDurationMs: number;     // 20 by default
  onUnderrun?: (msg: string) => void;
};

export function createLoopbackTrack(opts: TrackGenOpts): {
  track: MediaStreamTrack;
  stream: MediaStream;
  pushFrame: (channelData: Float32Array[], timestampUs: number, seq: number) => void;
  close: () => Promise<void>;
} {
  const Ctor = (globalThis as any).MediaStreamTrackGenerator as new (init: { kind: 'audio' }) => MediaStreamTrack & {
    writable: WritableStream<AudioData>;
  };
  const generator = new Ctor({ kind: 'audio' });
  const writer = generator.writable.getWriter();

  let baseTsUs: number | null = null;
  let framesWritten = 0;
  const samplesPerFrame = Math.round((opts.frameDurationMs * SAMPLE_RATE) / 1000); // 960 for 20ms

  // Prime with one silent frame so consumers (mediasoup) observe a live track immediately.
  const silentPlanar = new Float32Array(samplesPerFrame * NUM_CHANNELS); // zero-filled
  void writer.write(new AudioData({
    format: 'f32-planar',
    sampleRate: SAMPLE_RATE,
    numberOfFrames: samplesPerFrame,
    numberOfChannels: NUM_CHANNELS,
    timestamp: 0,
    data: silentPlanar
  }));

  const pushFrame = (channelData: Float32Array[], timestampUs: number, _seq: number) => {
    // Merge planar Float32Arrays into one contiguous planar buffer
    const frames = channelData[0].length;
    const merged = new Float32Array(frames * NUM_CHANNELS);
    merged.set(channelData[0], 0);
    merged.set(channelData[1] ?? channelData[0], frames);

    if (baseTsUs === null) baseTsUs = timestampUs;
    // Prefer synthetic monotonic timestamp derived from frame count — robust against Rust clock wraps.
    const ts = Math.round((framesWritten * 1_000_000) / SAMPLE_RATE);
    framesWritten += frames;

    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: frames,
      numberOfChannels: NUM_CHANNELS,
      timestamp: ts,
      data: merged
    });
    void writer.write(ad);
  };

  const close = async () => {
    try { await writer.close(); } catch { /* ignore */ }
    try { generator.stop(); } catch { /* ignore */ }
  };

  const stream = new MediaStream([generator]);
  return { track: generator, stream, pushFrame, close };
}
```

**AudioData format decision: `f32-planar`.** Rationale: `@wasm-audio-decoders/opus` outputs `Float32Array[]` (one per channel), so planar is a direct pack. WebCodecs planar layout for 2 channels of N frames expects a buffer of length `2*N` with channel 0 occupying `[0, N)` and channel 1 occupying `[N, 2N)` — exactly what the code above constructs.

**Priming decision: yes, write one 20 ms silent frame immediately.** This guarantees the track is in `live` state before `sendTransport.produce` runs and eliminates an observed race where mediasoup-client errors with "track ended" if produce happens before any `write()`.

**Timestamp decision: synthetic monotonic** (frame-count × 1e6 / sampleRate). We deliberately ignore the Rust-side `timestamp_us` for writing to `AudioData`. Reason: (a) it wraps at ~71 min; (b) WebCodecs expects a strictly monotonic per-track timebase; (c) the Rust clock is only used for drift diagnostics (stats). The seq/timestampUs are still forwarded for debug logging + future drift analysis.

### 4.8 `index.ts` — public API

```ts
import type { SystemLoopbackHandle, SystemLoopbackStartOpts, SystemLoopbackDeviceInfo, SystemLoopbackState } from './types';

export async function listSystemAudioDevices(): Promise<SystemLoopbackDeviceInfo[]> {
  const { ensureTauriEnv } = await import('./featureDetect');
  ensureTauriEnv();
  const { listDevices } = await import('./tauriBridge');
  return listDevices();
}

export async function startSystemAudioLoopback(opts: SystemLoopbackStartOpts = {}): Promise<SystemLoopbackHandle> {
  const { ensureTauriEnv, ensureInsertableStreams } = await import('./featureDetect');
  ensureTauriEnv();
  ensureInsertableStreams();

  const { startSession } = await import('./tauriBridge');      // starts Rust session, returns sessionId + state stream
  const { createLoopbackTrack } = await import('./trackGenerator');
  // decoder worker created inside tauriBridge
  const frameDurationMs = opts.frameDurationMs ?? 20;
  const { track, stream, pushFrame, close: closeTrack } = createLoopbackTrack({ frameDurationMs });
  return startSession(opts, { pushFrame, closeTrack, track, stream });
}

export async function stopSystemAudioLoopback(handle: SystemLoopbackHandle): Promise<void> {
  await handle.stop();
}
```

All imports inside functions (dynamic) — the module graph is only pulled in when the user actually toggles the feature. Matches AGENTS.md "use dynamic import() to code-split".

### 4.9 Lifecycle summary (happy path)

1. User clicks toggle.
2. `startSystemAudioLoopback({ deviceId? })` resolves.
3. `tauriBridge` spawns decoder worker (`new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })`) and awaits its `ready` message.
4. `tauriBridge` creates `Channel<ArrayBuffer>` + `Channel<SystemLoopbackState>`.
5. `invoke('plugin:audio-loopback|audio_loopback_start', ...)` → returns `sessionId`.
6. Rust starts capture + encode threads. First ALF1 frame arrives in ~30 ms.
7. Bridge parses ALF1 → worker decodes Opus → planar f32 → main-thread `pushFrame` → `AudioData.write`.
8. Meanwhile, `webrtc.produceSystemAudio(handle.track)` runs mediasoup produce.

---

## 5. Mediasoup Integration

### 5.1 Server codec — already correct

[`server/src/mediasoup.ts`](../server/src/mediasoup.ts:64-70) already declares:

```ts
{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }
```

This satisfies stereo Opus 48 kHz negotiation with our Rust-fed track. **No change required.**

### 5.2 Server `handleProduce` — extend source whitelist

File: [`server/src/ws/handlers.ts`](../server/src/ws/handlers.ts:3518-3571).

Current code accepts `'mic' | 'screen' | 'camera'` (see [`server/src/ws/handlers.ts`](../server/src/ws/handlers.ts:3542-3545)). Add `'system-audio'`:

1. Change the union type in the `handleProduce` payload (L3518) from `'mic' | 'screen' | 'camera'` to `'mic' | 'screen' | 'camera' | 'system-audio'`.
2. Change the normalization branch (L3542-3545) to include `'system-audio'`.
3. The mute/deafen gate (L3547) stays **mic-only** — system-audio must keep flowing when the user is muted (same semantic as screen-audio).
4. Propagate `source` in the `new_producer` broadcast (L3566) unchanged — it already forwards the raw string.
5. Update `handleCloseProducer` normalization (L3588-3591) identically.
6. Update `new_producer` listing in the `get_producers`-style handler ([`server/src/ws/handlers.ts`](../server/src/ws/handlers.ts:3719-3721) and [`:4393-4396`](../server/src/ws/handlers.ts:4393)) to include `'system-audio'`.

No DB migration required — the SQLite schema does not persist producer sources.

### 5.3 Client `produceSystemAudio()` — add to `webrtc.ts`

File: [`client/src/stores/webrtc.ts`](../client/src/stores/webrtc.ts:1).

Changes:

1. Widen the type alias (L10):
   ```ts
   type MediaSourceType = 'mic' | 'screen' | 'camera' | 'system-audio';
   ```
2. Widen the source validator inside the `'produce'` transport event handler (L1529-1535) to accept `'system-audio'`:
   ```ts
   const source: MediaSourceType =
     appDataSource === 'mic' || appDataSource === 'screen' || appDataSource === 'camera' || appDataSource === 'system-audio'
       ? appDataSource
       : inferredSource;
   ```
3. Add a new `shallowRef` next to `screenAudioProducer`:
   ```ts
   const systemAudioProducer = shallowRef<any | null>(null);
   const systemAudioHandle = shallowRef<import('@/audio/systemLoopback/types').SystemLoopbackHandle | null>(null);
   ```
4. Add `produceSystemAudio` and `unproduceSystemAudio`:
   ```ts
   const produceSystemAudio = async (opts: { deviceId?: string } = {}) => {
     if (systemAudioProducer.value || systemAudioHandle.value) return;
     if (!activeVoiceChannelId.value) throw new Error('Join a voice channel first.');
     const readySend = await waitForSendTransport();
     if (!readySend) throw new Error('Send transport not ready.');
     if (!device.value?.canProduce('audio')) throw new Error('Device cannot produce audio.');

     const { startSystemAudioLoopback } = await import('@/audio/systemLoopback');
     const handle = await startSystemAudioLoopback({ deviceId: opts.deviceId });
     systemAudioHandle.value = handle;

     try {
       systemAudioProducer.value = await readySend.produce({
         track: handle.track,
         codecOptions: {
           opusStereo: true,
           opusDtx: false,
           opusFec: true,
           opusMaxPlaybackRate: 48000
         },
         appData: { source: 'system-audio' as MediaSourceType }
       });
     } catch (err) {
       try { await handle.stop(); } catch { /* ignore */ }
       systemAudioHandle.value = null;
       throw err;
     }

     systemAudioProducer.value.on('transportclose', () => {
       void unproduceSystemAudio(false);
     });
   };

   const unproduceSystemAudio = async (notifyServer: boolean = true) => {
     const p = systemAudioProducer.value;
     const h = systemAudioHandle.value;
     systemAudioProducer.value = null;
     systemAudioHandle.value = null;
     if (p) {
       try { p.close(); } catch { /* ignore */ }
       if (notifyServer && activeVoiceChannelId.value) {
         chatStore.send('close_producer', {
           channel_id: activeVoiceChannelId.value,
           producer_id: p.id
         });
       }
     }
     if (h) { try { await h.stop(); } catch { /* ignore */ } }
   };
   ```
5. Expose both in the store's return object (same pattern used for `startScreenShare` / `stopScreenShare`).
6. Ensure `leaveVoice()`/cleanup paths call `unproduceSystemAudio(true)` before tearing down transports (search for `cleanupScreenShareProducer(` call-sites and add an adjacent `void unproduceSystemAudio(true)` invocation).
7. Consumer-side: existing code in [`client/src/stores/webrtc.ts`](../client/src/stores/webrtc.ts:1642) already routes `new_producer` with `source` through `producerToSource`. Extend the `MediaSourceType` cast at L1646 to recognise `'system-audio'` — the generic inference block will now pass it through unchanged. Remote rendering: system-audio consumers should play through a plain `<audio>` element (same as screen-audio), obeying the output device/volume. Reuse the screen-audio volume path at first — UX-wise treat `'system-audio'` producers from other users identically to screen-audio streams in v1.

### 5.4 UI hook-point

Target: [`client/src/components/layout/modals/ServerSettingsModal.vue`](../client/src/components/layout/modals/ServerSettingsModal.vue:1) — NO. Wrong location; that file is for server admin settings.

Correct target: a new small in-voice control rendered next to the existing screen-share button inside [`client/src/components/layout/MemberListSidebar.vue`](../client/src/components/layout/MemberListSidebar.vue:1) voice controls footer (if present) OR — preferred — inside the **user settings voice panel** at [`client/src/components/layout/modals/UserSettingsModal.vue`](../client/src/components/layout/modals/UserSettingsModal.vue:1), as an opt-in toggle only visible when `window.__TAURI_INTERNALS__` is present (guard via `featureDetect.ensureTauriEnv` inside a computed flag).

Minimal UI contract (v1):
- One toggle button: "Share system audio" (on/off).
- One `<select>` populated from `listSystemAudioDevices()` — disabled while the session is active.
- Error text region bound to state's `error` variant.

No styling spec — follow existing Tailwind patterns in the host component.

---

## 6. Security / Capabilities / Platform Notes

### 6.1 Windows-only v1

`capture.rs` has a `#[cfg(windows)]` module plus a `#[cfg(not(windows))]` stub module. All public command functions are available on all platforms; on non-Windows they return `Error::Unsupported`. Builds succeed on mac/linux dev machines, the plugin simply refuses to start capture.

### 6.2 DRM-protected audio

WASAPI shared-mode loopback **cannot capture DRM-flagged streams** (e.g. Netflix via Edge's PlayReady path). Captured audio from such streams is silent. This is a Windows OS behaviour; we do not attempt to bypass. Document in README when shipping.

### 6.3 CSP + Tauri IPC

Chosen CSP (§2.2) explicitly allows:
- `'wasm-unsafe-eval'` — required for the Opus decoder's WASM instantiation under strict CSP.
- `worker-src 'self' blob:` — required for the decoder worker (bundled at `self` origin) **and** the `@wasm-audio-decoders/opus` internal worker, which is a `Blob` URL.
- `media-src 'self' blob: mediastream:` — required for `MediaStreamTrackGenerator` sources consumed by `<audio>` elements.
- `connect-src ipc: http://ipc.localhost` — Tauri v2 IPC transport.

### 6.4 Permissions

No Windows ACLs or capability manifests beyond the Tauri ACL in §2.4. No admin privileges required. No firewall changes. WebView2 runtime is the only deployment prerequisite (see §7).

### 6.5 Privacy note

A visible indicator ("System audio is being shared") must render in the voice channel participant strip for both the sharer and listeners in a later iteration. Tracked in §8 as an open implementation question but NOT a v1 blocker.

---

## 7. Build / Run Instructions (planned)

### 7.1 Windows dev prerequisites

- Rust toolchain `>= 1.77` (stable, MSVC): `rustup default stable-x86_64-pc-windows-msvc`.
- Visual Studio 2022 Build Tools with "Desktop development with C++" workload (MSVC, Windows SDK, CMake). CMake is required for `audiopus_sys` to build libopus from vendored sources.
- WebView2 Runtime — bundled via `webviewInstallMode: embedBootstrapper` at build time; dev build requires an installed runtime on the machine (standard on Win10 2004+ / Win11).
- `cargo install tauri-cli --version "^2"` — provides `tauri` CLI. Alternatively use the project-local `@tauri-apps/cli@2.10.1` already declared in [`client/package.json`](../client/package.json:26).

### 7.2 Dev

```bash
cd client
npm install
npm run tauri:dev
```

Vite dev server listens on `:1420`, Tauri shell connects to it.

### 7.3 Production build

```bash
cd client
npm install
npm run tauri:build
```

Artifacts land in `client/src-tauri/target/release/bundle/{msi,nsis}/`.

### 7.4 Smoke test checklist

1. `npm run tauri:dev` opens the shell; dev-tools reachable.
2. Join a voice channel with ≥ 2 participants.
3. Toggle "Share system audio"; pick a device; start.
4. Play audio on the selected endpoint. Confirm remote peers hear it as a separate audio stream (tagged `system-audio`).
5. Toggle off; confirm Rust logs "session stopped" and the producer closes on the server.
6. Unplug the selected endpoint mid-session; expect `StateMessage::Error` → UI resets to idle.

---

## 8. Open Questions Deferred to Implementation

Items below are small enough that the implementing author may pick without re-opening the spec:

1. **Default device name fallback.** `wasapi` occasionally returns empty friendly-names. Decide: use `"Output (device {shortId})"` or the raw endpoint id.
2. **`produceSystemAudio` race during `voice:leave`.** Current order in `leaveVoice` closes transports before producers. Author decides whether to call `unproduceSystemAudio(false)` early or rely on `transportclose` hooks.
3. **Remote-side volume UI.** Whether to surface a separate volume slider for incoming system-audio (current screen-audio volume slider is per-user; system-audio will reuse it). Author decides; v1 may simply share the slider.
4. **Device change during session.** If the user switches Windows default output, should we auto-rebind? v1 recommendation: no, surface an `Error::Wasapi("device changed")` and let the user restart.
5. **Metrics sampling interval.** `Stats::encoder_latency_us_p*` requires a reservoir sampler; author picks reservoir size (recommend 2048).
6. **Opus encoder application hint.** `AUDIO` vs `LOW_DELAY`. Recommendation: `AUDIO`. Author may benchmark and switch.
7. **Plugin init failures.** If `init()` fails (e.g., COM init returns HRESULT), decide between panicking during `Builder::plugin` vs registering a "degraded" command that always returns `Error::Unsupported`. Recommend the latter.
8. **Visible "system-audio-on" indicator in the member list.** Not implemented in v1; tracked here for UX follow-up.
9. **`@wasm-audio-decoders/opus` path resolution under Tauri.** If Vite's worker URL resolution misbehaves in the Tauri context, fall back to an inline `Worker` loaded from `new Blob([...], { type: 'application/javascript' })`.

---

## 9. Edge Cases & Failure Modes Checklist

| Scenario | Expected behaviour |
| --- | --- |
| Selected render device is physically unplugged mid-session | WASAPI returns `AUDCLNT_E_DEVICE_INVALIDATED` on next buffer fetch. Capture thread emits `StateMessage::Error { "device removed" }`; session transitions to stopped; JS handle's `onStateChange` fires; `produceSystemAudio` callers should catch and call `unproduceSystemAudio(true)`. |
| Sample rate switches (48 → 44.1 kHz) because user opens an exclusive-mode app | Device invalidation; same path as above. We do NOT attempt seamless reconfig in v1. |
| Device channel count switches (stereo → 5.1) | Captured at device rate; our resampler collapses to stereo via straight L/R pick + center-fold-into-both (`C * 0.707`) + LFE drop. Precise downmix matrix lives in `resample.rs`. |
| Capture produces faster than encoder drains (CPU spike) | Ring-buffer overflow; drop oldest; `frames_dropped_ring_overflow++`. |
| Tauri IPC channel buffer saturates (WebView2 slow) | `Channel::send` returns `Err`; encoder logs once per second, increments `frames_dropped_channel_full`, continues. No back-off. |
| Browser window reload (Ctrl+R) | Channels detach (`send` errors); the plugin's `on_window_event(WebviewWindow::Destroyed)` hook triggers `stop_all()`. On reload, JS re-initiates `audio_loopback_start`. |
| Opus decoder worker crashes | `decoder.worker.ts` posts `{ type: 'error' }`; `tauriBridge` stops pushing frames; `trackGenerator.close()`; `onStateChange('error')`; `webrtc.produceSystemAudio` catch unplugs producer. |
| `MediaStreamTrackGenerator` becomes garbage-collected before producer holds a strong ref | Prevented by holding `handle.stream` + `systemAudioHandle` ref in Pinia store. Additionally, `trackGenerator.createLoopbackTrack` retains the `writer` via closure so the writable stream is never detached. |
| User stops Rust session but forgets to close the mediasoup producer | `unproduceSystemAudio` always runs in tandem; additionally, `track.onended` → `producer.close()` path set in `produceSystemAudio`. |
| Windows audio engine glitch forces capture thread to block > 100 ms | `WaitForSingleObject` times out at `AUDCLNT_BUFFER_DURATION + 10 ms`; on 3 consecutive timeouts, emit error & stop. |
| `audiopus_sys` fails to build on CI (no cmake) | Documented in §3.3; fallback to `opus = "0.3"` crate. Author must regenerate `Cargo.lock`. |
| Concurrent `audio_loopback_start` (double-click toggle) | `SessionManager` returns `Error::AlreadyRunning`; UI must disable button while request in-flight. |
| `listDevices()` called on non-Windows | Returns `Err(Error::Unsupported)`. |
| Single-channel (mono) render endpoint | `resample.rs` duplicates the mono channel into L/R prior to encode. |
| 24-bit / 32-bit PCM device formats | `wasapi::WaveFormat` negotiates `SAMPLE_FORMAT::Float` (IEEE float) in shared mode by requesting a mix format; if the device refuses, fall through to int16 → f32 conversion in `capture.rs`. |

---

*End of spec.*
