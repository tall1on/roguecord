// Thin wrapper around the Rust-side tauri-plugin-audio-loopback IPC.
//
// Command prefix: `plugin:audio-loopback|` (registered in
// client/src-tauri/crates/tauri-plugin-audio-loopback/src/lib.rs).
//
// Tauri v2 `Channel<T>` is used for both the framing channel (binary ALF1
// Opus-over-IPC) and for the structured JSON `state` channel.

import { Channel, invoke } from '@tauri-apps/api/core';
import type { DeviceInfo, StartOpts, Stats, StateMessage } from './types';

const CMD_LIST = 'plugin:audio-loopback|audio_loopback_list_devices';
const CMD_START = 'plugin:audio-loopback|audio_loopback_start';
const CMD_STOP = 'plugin:audio-loopback|audio_loopback_stop';
const CMD_STATS = 'plugin:audio-loopback|audio_loopback_stats';

// ASCII "ALF1" magic — 0x41 0x4C 0x46 0x31.
const ALF1_MAGIC_LE_U32 = 0x31464c41;

export type ParsedFrame = {
  magicOk: boolean;
  sessionId: number;
  seq: number;
  timestampUs: number;
  opus: Uint8Array;
};

/**
 * Validate the ALF1 header and return a view over the Opus payload.
 *
 * `buf` should be an ArrayBuffer carrying `16 header bytes + opus bytes`.
 * Defensively accepts `Uint8Array` or `{ data: number[] }` shapes in case
 * a Tauri version delivers raw binary payloads as JSON-encoded arrays.
 */
export function parseFrameHeader(
  buf: ArrayBuffer | Uint8Array | { data?: ArrayLike<number> } | ArrayLike<number>
): ParsedFrame {
  let ab: ArrayBuffer;

  if (buf instanceof ArrayBuffer) {
    ab = buf;
  } else if (buf instanceof Uint8Array) {
    ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } else if (buf && typeof (buf as any).data !== 'undefined' && (buf as any).data) {
    const arr = Uint8Array.from((buf as { data: ArrayLike<number> }).data);
    ab = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
  } else if (buf && typeof (buf as any).length === 'number') {
    const arr = Uint8Array.from(buf as ArrayLike<number>);
    ab = arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
  } else {
    return { magicOk: false, sessionId: 0, seq: 0, timestampUs: 0, opus: new Uint8Array(0) };
  }

  if (ab.byteLength < 16) {
    return { magicOk: false, sessionId: 0, seq: 0, timestampUs: 0, opus: new Uint8Array(0) };
  }

  const dv = new DataView(ab);
  const magic = dv.getUint32(0, true);
  if (magic !== ALF1_MAGIC_LE_U32) {
    return { magicOk: false, sessionId: 0, seq: 0, timestampUs: 0, opus: new Uint8Array(0) };
  }
  const sessionId = dv.getUint32(4, true);
  const seq = dv.getUint32(8, true);
  const timestampUs = dv.getUint32(12, true);
  const opus = new Uint8Array(ab, 16, ab.byteLength - 16);
  return { magicOk: true, sessionId, seq, timestampUs, opus };
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const raw = await invoke<DeviceInfo[]>(CMD_LIST);
  return Array.isArray(raw) ? raw : [];
}

export type StartResult = {
  sessionId: number;
  stop: () => Promise<void>;
  getStats: () => Promise<Stats>;
};

/**
 * Start a loopback session. Caller supplies handlers for raw ALF1 frames
 * and lifecycle state messages.
 *
 * The returned `stop()` is idempotent and severs both handlers.
 */
export async function startCapture(
  opts: StartOpts,
  onFrame: (buf: ArrayBuffer) => void,
  onState: (msg: StateMessage) => void
): Promise<StartResult> {
  const framesChan = new Channel<ArrayBuffer>();
  const stateChan = new Channel<StateMessage>();

  framesChan.onmessage = (raw) => {
    try {
      // `raw` should be an ArrayBuffer. Defensively re-normalise if the
      // Tauri runtime chose to JSON-encode the payload instead.
      if (raw instanceof ArrayBuffer) {
        onFrame(raw);
      } else if (raw && (raw as any).buffer instanceof ArrayBuffer) {
        const v = raw as unknown as ArrayBufferView;
        onFrame(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
      } else if (raw && typeof (raw as any).data !== 'undefined') {
        const arr = Uint8Array.from((raw as unknown as { data: ArrayLike<number> }).data);
        onFrame(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer);
      } else if (raw && typeof (raw as any).length === 'number') {
        const arr = Uint8Array.from(raw as unknown as ArrayLike<number>);
        onFrame(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer);
      }
    } catch (err) {
      // Swallow bridge-side decode errors; surfacing them via onState would
      // incorrectly mark the Rust session as errored.
      // eslint-disable-next-line no-console
      console.warn('[systemLoopback] frame callback failed', err);
    }
  };

  stateChan.onmessage = (msg) => {
    try {
      onState(msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[systemLoopback] state callback failed', err);
    }
  };

  const sessionId = await invoke<number>(CMD_START, {
    opts,
    frames: framesChan,
    state: stateChan
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Detach handlers so late-arriving messages do not fire.
    framesChan.onmessage = () => {};
    stateChan.onmessage = () => {};
    try {
      await invoke(CMD_STOP, { session: sessionId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[systemLoopback] audio_loopback_stop failed', err);
    }
  };

  const getStats = async (): Promise<Stats> => {
    return invoke<Stats>(CMD_STATS, { session: sessionId });
  };

  return { sessionId, stop, getStats };
}
