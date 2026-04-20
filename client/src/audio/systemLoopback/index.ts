// Public API for the system-audio loopback feature.
//
// Usage (lazy import from call-site, per AGENTS.md dynamic-import rule):
//
//   const { startSystemAudioLoopback } = await import('@/audio/systemLoopback');
//   const handle = await startSystemAudioLoopback({ deviceId });
//   sendTransport.produce({ track: handle.track, appData: { source: 'system-audio' } });
//
// The feature graph (tauriBridge, trackGenerator, decoder.worker) is loaded
// lazily here too, so importing this module is cheap until `start` is called.

import { assertSupport, isTauriRuntime } from './featureDetect';
import type {
  DeviceInfo,
  StartOpts,
  Stats,
  StateMessage,
  SystemLoopbackHandle,
  DecoderInbound,
  DecoderOutbound
} from './types';
// Vite worker import — produces a Worker constructor with correct URL resolution
// for both `vite dev` and production builds (including Tauri's bundled assets).
import LoopbackWorker from './decoder.worker.ts?worker';

export { isTauriRuntime, hasMediaStreamTrackGenerator } from './featureDetect';
export type {
  DeviceInfo,
  StartOpts,
  Stats,
  StateMessage,
  SystemLoopbackHandle
} from './types';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const DEFAULT_FRAME_MS = 20;

export async function listSystemAudioDevices(): Promise<DeviceInfo[]> {
  if (!isTauriRuntime()) {
    throw new Error('system-audio loopback requires the Tauri desktop app');
  }
  const { listDevices } = await import('./tauriBridge');
  return listDevices();
}

type StateListener = (s: StateMessage) => void;

type Internals = {
  worker: Worker;
  bridgeStop: () => Promise<void>;
  sink: import('./trackGenerator').LoopbackTrackSink;
  listeners: Set<StateListener>;
  stopping: boolean;
};

export async function startSystemAudioLoopback(
  opts: Partial<StartOpts> & { deviceId?: string } = {}
): Promise<SystemLoopbackHandle> {
  assertSupport();

  const frameDurationMs = (opts.frameDurationMs ?? DEFAULT_FRAME_MS) as number;
  const startOpts: StartOpts = {
    deviceId: opts.deviceId,
    bitrateBps: opts.bitrateBps ?? 128000,
    frameDurationMs: (opts.frameDurationMs ?? DEFAULT_FRAME_MS) as StartOpts['frameDurationMs'],
    complexity: opts.complexity ?? 10,
    channels: opts.channels ?? CHANNELS
  };

  // Dynamic imports — deferred until start so the web/non-Tauri bundle stays lean.
  const [{ startCapture, parseFrameHeader }, { LoopbackTrackSink }] = await Promise.all([
    import('./tauriBridge'),
    import('./trackGenerator')
  ]);

  // 1. Track sink first so the MediaStreamTrack is live before the producer runs.
  const sink = new LoopbackTrackSink({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    frameDurationMs,
    onDrop: () => {
      // Drops are logged internally; we just ensure we don't crash.
    }
  });

  // 2. Decoder worker.
  const worker: Worker = new LoopbackWorker();

  const workerReady = new Promise<void>((resolve, reject) => {
    const onMsg = (ev: MessageEvent<DecoderOutbound>) => {
      const msg = ev.data;
      if (msg.type === 'ready') {
        worker.removeEventListener('message', onMsg);
        resolve();
      } else if (msg.type === 'error') {
        worker.removeEventListener('message', onMsg);
        reject(new Error(msg.message));
      }
    };
    worker.addEventListener('message', onMsg);
  });

  const initMsg: DecoderInbound = {
    type: 'init',
    frameDurationMs,
    channels: CHANNELS,
    sampleRate: SAMPLE_RATE
  };
  worker.postMessage(initMsg);

  try {
    await workerReady;
  } catch (err) {
    worker.terminate();
    await sink.close();
    throw err;
  }

  const listeners = new Set<StateListener>();
  const internals: Internals = {
    worker,
    bridgeStop: async () => {},
    sink,
    listeners,
    stopping: false
  };

  // Wire decoder output -> track sink.
  worker.addEventListener('message', (ev: MessageEvent<DecoderOutbound>) => {
    const msg = ev.data;
    if (msg.type === 'pcm') {
      sink.pushPcm(msg.channels, msg.samples);
    } else if (msg.type === 'error') {
      // eslint-disable-next-line no-console
      console.warn('[systemLoopback] decoder error', msg.message);
      emitError(internals, msg.message);
    }
  });

  const onFrame = (buf: ArrayBuffer) => {
    const parsed = parseFrameHeader(buf);
    if (!parsed.magicOk || parsed.opus.byteLength === 0) return;
    // Transfer the opus buffer into the worker to avoid copies.
    const opusCopy = parsed.opus.slice(0); // own the bytes
    const m: DecoderInbound = {
      type: 'frame',
      opus: opusCopy.buffer,
      seq: parsed.seq,
      timestampUs: parsed.timestampUs
    };
    worker.postMessage(m, [opusCopy.buffer]);
  };

  const onState = (msg: StateMessage) => {
    for (const cb of listeners) {
      try {
        cb(msg);
      } catch {
        // ignore listener errors
      }
    }
    if (msg.state === 'stopped' || msg.state === 'error') {
      void stop();
    }
  };

  // 3. Ignite Rust session.
  let bridge: Awaited<ReturnType<typeof startCapture>>;
  try {
    bridge = await startCapture(startOpts, onFrame, onState);
  } catch (err) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    await sink.close();
    throw err;
  }
  internals.bridgeStop = bridge.stop;

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    internals.stopping = true;
    try {
      await internals.bridgeStop();
    } catch {
      // ignore
    }
    try {
      worker.postMessage({ type: 'close' } satisfies DecoderInbound);
    } catch {
      // ignore
    }
    try {
      worker.terminate();
    } catch {
      // ignore
    }
    await sink.close();
    listeners.clear();
  };

  const handle: SystemLoopbackHandle = {
    sessionId: bridge.sessionId,
    track: sink.track,
    stream: sink.stream,
    stop,
    onStateChange: (cb: StateListener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getStats: () => bridge.getStats()
  };

  return handle;
}

function emitError(internals: Internals, message: string): void {
  const fakeErr: StateMessage = { state: 'error', session: -1, error: message };
  for (const cb of internals.listeners) {
    try {
      cb(fakeErr);
    } catch {
      // ignore
    }
  }
}
