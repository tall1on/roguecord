/// <reference lib="webworker" />
// Opus-decoder web worker. Receives encoded ALF1 Opus packets from the main
// thread, decodes to Float32 planar PCM using @wasm-audio-decoders/opus, and
// posts PCM back to the main thread with transferable buffers.
//
// Protocol: see ../systemLoopback/types.ts (DecoderInbound / DecoderOutbound).

import type { DecoderInbound, DecoderOutbound } from './types';

// Library types are loose; we narrow at usage sites.
type OpusDecoderCtor = new (opts: {
  channels?: number;
  forceStereo?: boolean;
  preSkip?: number;
  sampleRate?: number;
}) => {
  ready: Promise<void>;
  decodeFrame: (packet: Uint8Array) => Promise<{
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
  }> | {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
  };
  reset?: () => Promise<void> | void;
  free?: () => Promise<void> | void;
};

type DecoderInstance = InstanceType<OpusDecoderCtor>;

let decoder: DecoderInstance | null = null;
let initPromise: Promise<void> | null = null;
let closing = false;

const post = (msg: DecoderOutbound, transfer: Transferable[] = []) => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
};

async function ensureDecoder(channels: number): Promise<DecoderInstance> {
  if (decoder) return decoder;
  if (!initPromise) {
    initPromise = (async () => {
      // Prefer the library's web-worker-wrapped decoder if available; fall
      // back to the plain in-worker decoder. Both share the same API surface.
      const mod = await import('opus-decoder');
      const Ctor: OpusDecoderCtor =
        ((mod as any).OpusDecoderWebWorker as OpusDecoderCtor | undefined) ??
        ((mod as any).OpusDecoder as OpusDecoderCtor);
      if (!Ctor) {
        throw new Error('@wasm-audio-decoders/opus: no OpusDecoder export found');
      }
      decoder = new Ctor({
        channels,
        forceStereo: channels === 2,
        sampleRate: 48000
      });
      await decoder.ready;
    })();
  }
  await initPromise;
  if (!decoder) throw new Error('opus decoder did not initialise');
  return decoder;
}

async function handleMessage(msg: DecoderInbound): Promise<void> {
  switch (msg.type) {
    case 'init': {
      try {
        await ensureDecoder(msg.channels ?? 2);
        post({ type: 'ready' });
      } catch (err) {
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      break;
    }
    case 'frame': {
      if (closing) return;
      try {
        const d = await ensureDecoder(2);
        const packet = new Uint8Array(msg.opus);
        const result = await Promise.resolve(d.decodeFrame(packet));
        const channels = result.channelData;
        const samples = result.samplesDecoded;
        const sampleRate = result.sampleRate;
        // Copy into fresh buffers that we exclusively own — some Opus decoder
        // implementations reuse a single internal typed-array per channel.
        // Transferring the originals would corrupt the next frame's data.
        const copied: Float32Array[] = channels.map((ch) => {
          const buf = new Float32Array(ch.length);
          buf.set(ch);
          return buf;
        });
        const transfer: Transferable[] = copied.map((ch) => ch.buffer);
        post(
          {
            type: 'pcm',
            channels: copied,
            samples,
            sampleRate,
            seq: msg.seq,
            timestampUs: msg.timestampUs
          },
          transfer
        );
      } catch (err) {
        post({
          type: 'error',
          message: err instanceof Error ? err.message : String(err)
        });
      }
      break;
    }
    case 'flush': {
      if (decoder?.reset) {
        try {
          await Promise.resolve(decoder.reset());
        } catch (err) {
          post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err)
          });
        }
      } else {
        // Force re-instantiation if the library did not expose `reset`.
        decoder = null;
        initPromise = null;
      }
      break;
    }
    case 'close': {
      closing = true;
      try {
        if (decoder?.free) await Promise.resolve(decoder.free());
      } catch {
        // ignore
      }
      decoder = null;
      initPromise = null;
      (self as unknown as DedicatedWorkerGlobalScope).close();
      break;
    }
  }
}

self.onmessage = (ev: MessageEvent<DecoderInbound>) => {
  void handleMessage(ev.data);
};
