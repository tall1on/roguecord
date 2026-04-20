// Shared DTOs for the system-audio-loopback module.
// Must mirror camelCase field names emitted by the Rust plugin
// (tauri-plugin-audio-loopback, see src/types.rs in that crate).

export type DeviceInfo = {
  id: string;
  name: string;
  isDefaultOutput: boolean;
  sampleRate?: number;
  channels?: number;
};

export type OpusFrameDurationMs = 5 | 10 | 20 | 40 | 60;

export type StartOpts = {
  deviceId?: string;
  bitrateBps?: number;     // default 128000
  frameDurationMs?: OpusFrameDurationMs; // default 20
  complexity?: number;     // 0..=10, default 10
  channels?: number;       // default 2
};

export type Stats = {
  session: number;
  framesEmitted: number;
  framesDroppedRingOverflow: number;
  framesDroppedChannelFull: number;
  encoderLatencyUsP50: number;
  encoderLatencyUsP99: number;
  captureDeviceSampleRate: number;
  captureDeviceChannels: number;
  startedAtUnixMs: number;
};

export type StateMessage =
  | {
      state: 'started';
      session: number;
      deviceId: string;
      deviceName: string;
      deviceSampleRate: number;
      deviceChannels: number;
    }
  | {
      state: 'stopped';
      session: number;
      reason: string;
    }
  | {
      state: 'error';
      session: number;
      error: string;
    };

export type SystemLoopbackHandle = {
  readonly sessionId: number;
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  stop(): Promise<void>;
  onStateChange(cb: (s: StateMessage) => void): () => void;
  getStats(): Promise<Stats>;
};

// Worker protocol (main-thread <-> decoder.worker.ts)
export type DecoderInbound =
  | { type: 'init'; frameDurationMs: number; channels: number; sampleRate: number }
  | { type: 'frame'; opus: ArrayBuffer; seq: number; timestampUs: number }
  | { type: 'flush' }
  | { type: 'close' };

export type DecoderOutbound =
  | { type: 'ready' }
  | {
      type: 'pcm';
      channels: Float32Array[];
      samples: number;
      sampleRate: number;
      seq: number;
      timestampUs: number;
    }
  | { type: 'error'; message: string };
