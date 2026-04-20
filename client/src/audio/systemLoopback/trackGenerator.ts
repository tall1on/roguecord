// MediaStreamTrackGenerator-backed sink for decoded PCM frames.
//
// Consumes Float32 planar PCM (one Float32Array per channel) and writes
// AudioData instances to the generator's writable stream. Internally
// synthesises a monotonic timestamp from a running frame counter — per
// docs/system-audio-loopback-design.md §4.7 — so that the 32-bit wrap of
// the Rust-side capture clock cannot break the AudioData timebase.

/* Minimal ambient DOM types for MediaStreamTrackGenerator + AudioData
 * which are not yet in stock lib.dom.d.ts. */
declare global {
  interface AudioDataInit {
    format: string;
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
    timestamp: number;
    data: BufferSource;
  }
  // eslint-disable-next-line no-var
  var AudioData: { new (init: AudioDataInit): any } | undefined;
  interface MediaStreamTrackGeneratorInit {
    kind: 'audio' | 'video';
  }
  // eslint-disable-next-line no-var
  var MediaStreamTrackGenerator:
    | {
        new (init: MediaStreamTrackGeneratorInit): MediaStreamTrack & {
          writable: WritableStream<unknown>;
        };
      }
    | undefined;
}

export type LoopbackTrackSinkOpts = {
  sampleRate: number;
  channels: number;
  frameDurationMs: number;
  onDrop?: (count: number) => void;
};

export class LoopbackTrackSink {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;

  private readonly writer: WritableStreamDefaultWriter<unknown>;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly samplesPerPrimeFrame: number;
  private readonly onDrop: (count: number) => void;

  private frameCounter = 0;
  private primed = false;
  private closed = false;
  private dropCount = 0;
  private pendingWrite = false;

  constructor(opts: LoopbackTrackSinkOpts) {
    this.sampleRate = opts.sampleRate;
    this.channels = opts.channels;
    this.samplesPerPrimeFrame = Math.round((opts.frameDurationMs * opts.sampleRate) / 1000);
    this.onDrop = opts.onDrop ?? (() => {});

    const Ctor = (globalThis as any).MediaStreamTrackGenerator as NonNullable<
      typeof globalThis.MediaStreamTrackGenerator
    >;
    if (!Ctor) {
      throw new Error('MediaStreamTrackGenerator is not available in this environment');
    }
    const generator = new Ctor({ kind: 'audio' });
    this.track = generator as unknown as MediaStreamTrack;
    this.writer = (generator.writable as WritableStream<unknown>).getWriter();
    this.stream = new MediaStream([this.track]);

    try {
      this.track.contentHint = 'music';
    } catch {
      // Not all UAs implement contentHint setter for generator tracks.
    }
  }

  /** Returns the cumulative count of frames dropped due to writer backpressure. */
  get droppedFrames(): number {
    return this.dropCount;
  }

  /**
   * Push a decoded PCM frame. `channels` is an array of planar Float32Arrays,
   * one per channel, each of length = numFrames.
   */
  pushPcm(channels: Float32Array[], numFrames: number): void {
    if (this.closed) return;
    if (!channels.length || numFrames <= 0) return;

    if (!this.primed) {
      this.primed = true;
      this.writePrimeSilence();
    }

    // Build a single planar buffer: [ch0 samples ... | ch1 samples ...]
    const nCh = this.channels;
    const merged = new Float32Array(numFrames * nCh);
    for (let c = 0; c < nCh; c++) {
      const src = channels[c] ?? channels[0];
      if (src && src.length >= numFrames) {
        merged.set(src.subarray(0, numFrames), c * numFrames);
      } else if (src) {
        merged.set(src, c * numFrames);
      }
    }
    this.writeAudioData(merged, numFrames);
  }

  private writePrimeSilence(): void {
    const n = this.samplesPerPrimeFrame;
    if (n <= 0) return;
    const buf = new Float32Array(n * this.channels);
    this.writeAudioData(buf, n);
  }

  private writeAudioData(planar: Float32Array, numFrames: number): void {
    const AudioDataCtor = (globalThis as any).AudioData as NonNullable<typeof globalThis.AudioData>;
    if (!AudioDataCtor) return;

    const ts = Math.round((this.frameCounter * 1_000_000) / this.sampleRate);
    const ad = new AudioDataCtor({
      format: 'f32-planar',
      sampleRate: this.sampleRate,
      numberOfFrames: numFrames,
      numberOfChannels: this.channels,
      timestamp: ts,
      data: planar
    });

    // If a previous write is still queued, drop this frame rather than
    // accumulating unbounded backpressure — per design doc §9.
    if (this.pendingWrite) {
      this.dropCount += 1;
      this.onDrop(this.dropCount);
      try {
        (ad as unknown as { close?: () => void }).close?.();
      } catch {
        // ignore
      }
      return;
    }

    this.frameCounter += numFrames;
    this.pendingWrite = true;
    this.writer.ready
      .then(() => this.writer.write(ad as unknown as unknown))
      .catch((err) => {
        if (!this.closed) {
          // eslint-disable-next-line no-console
          console.warn('[systemLoopback] writer.write failed', err);
        }
      })
      .finally(() => {
        this.pendingWrite = false;
      });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer.close();
    } catch {
      // ignore
    }
    try {
      this.track.stop();
    } catch {
      // ignore
    }
  }
}
