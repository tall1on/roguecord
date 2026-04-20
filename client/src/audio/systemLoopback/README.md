# systemLoopback — client pipeline

Desktop-only (Tauri + WebView2) WASAPI system-audio loopback producer.

Pipeline:

```
Rust plugin (tauri-plugin-audio-loopback)
  │  Channel<ArrayBuffer>  (16-byte ALF1 header + Opus payload)
  ▼
tauriBridge.ts  ──▶  decoder.worker.ts  ──▶  trackGenerator.ts
                          (Opus → f32 PCM)     (AudioData → MediaStreamTrack)
                                                      │
                                                      ▼
                                 webrtc.ts (mediasoup Producer, source='system-audio')
```

All modules are dynamically imported from `index.ts` so non-Tauri / non-voice
users never pull in the decoder WASM or the worker code.

## ALF1 frame format (Rust → JS contract)

Every frame on the `frames` Channel is `16 + N` bytes, all little-endian:

- `[0..4]`  magic = ASCII `ALF1` (`0x41 0x4C 0x46 0x31`)
- `[4..8]`  `session_id`   u32 LE — matches SessionId returned by start
- `[8..12]` `seq`          u32 LE — monotonic from 0, wraps mod 2^32
- `[12..16]` `timestamp_us` u32 LE — capture monotonic clock (wraps ~71 min)
- `[16..]`  Opus packet (TOC + payload)

The JS side **ignores** `timestamp_us` when writing `AudioData` and uses a
synthetic frame-counter-derived timestamp instead — the 32-bit wrap is
acceptable for diagnostics but incompatible with the monotonic WebCodecs timebase.

## Files

- [`types.ts`](types.ts) — shared TS types (camelCase mirror of Rust DTOs).
- [`featureDetect.ts`](featureDetect.ts) — `isTauriRuntime()`, `hasMediaStreamTrackGenerator()`, `assertSupport()`.
- [`tauriBridge.ts`](tauriBridge.ts) — `invoke('plugin:audio-loopback|…')` wrappers, `parseFrameHeader` helper.
- [`decoder.worker.ts`](decoder.worker.ts) — wraps `@wasm-audio-decoders/opus`; reports PCM frames via transferable `postMessage`.
- [`trackGenerator.ts`](trackGenerator.ts) — `LoopbackTrackSink` + `MediaStreamTrackGenerator` + `AudioData` writer; sends a 20 ms silent prime frame.
- [`index.ts`](index.ts) — public API: `startSystemAudioLoopback`, `listSystemAudioDevices`, `isTauriRuntime`, `hasMediaStreamTrackGenerator`.
