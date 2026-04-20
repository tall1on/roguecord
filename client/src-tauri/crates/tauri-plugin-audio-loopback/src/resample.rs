//! Resampling + channel downmix pipeline.
//!
//! Converts device-native interleaved f32 PCM into 48 kHz planar stereo,
//! ready for the Opus encoder. Uses `rubato::FftFixedIn` as the sample-rate
//! conversion engine.
//!
//! Design decisions (from §3.6 of the design doc):
//!
//! * 48 kHz target sample rate, always stereo.
//! * Mono sources are duplicated L=R.
//! * Multi-channel sources (5.1/7.1) are downmixed:
//!   * `L_out = L + C * 0.707`
//!   * `R_out = R + C * 0.707`
//!   * Surround / LFE channels are dropped.
//! * Output planar buffers per channel, ready to be fed to `audiopus`.
//!
//! Windows-only build — rubato is still pure-Rust so could technically live
//! on other OSes, but the capture side is Windows-gated and nothing else
//! calls into this module currently.

use rubato::{FftFixedIn, Resampler};

use crate::error::{Error, Result};

/// Fixed target rate for the downstream Opus encoder.
pub const TARGET_RATE: usize = 48_000;

/// Target channel count (stereo).
pub const TARGET_CHANNELS: usize = 2;

/// Chunk size used for rubato's fixed-input API. 480 samples at device rate
/// corresponds to 10 ms at 48 kHz; for non-48 kHz inputs it simply fixes the
/// resampler's internal block granularity. Chosen to pair well with the
/// Opus 20 ms frames the encoder will request downstream.
pub const RESAMPLE_CHUNK: usize = 480;

/// Stateful resampler + downmixer.
pub struct ResamplePipeline {
    input_rate: usize,
    input_channels: usize,
    /// Rubato resampler (one per logical stereo channel). `None` if the
    /// input is already at the target rate — in which case we bypass.
    rs: Option<FftFixedIn<f32>>,
    /// Reusable interleaved->planar scratch. Length = `RESAMPLE_CHUNK`.
    planar_in: [Vec<f32>; TARGET_CHANNELS],
    /// Reusable output buffers returned by rubato.
    planar_out: Vec<Vec<f32>>,
    /// Output accumulator of 48 kHz planar stereo samples.
    /// The encoder consumes fixed-size chunks (960 samples @ 20 ms).
    out_acc: [Vec<f32>; TARGET_CHANNELS],
    /// Pending interleaved input bytes (when the caller does not align on
    /// `RESAMPLE_CHUNK` boundaries).
    leftover_in: Vec<f32>,
}

impl ResamplePipeline {
    pub fn new(input_rate: u32, input_channels: u16) -> Result<Self> {
        if input_channels == 0 {
            return Err(Error::InvalidOption(
                "device reports 0 channels".to_string(),
            ));
        }
        let input_rate = input_rate as usize;
        let input_channels = input_channels as usize;
        let rs = if input_rate == TARGET_RATE {
            None
        } else {
            Some(
                FftFixedIn::<f32>::new(
                    input_rate,
                    TARGET_RATE,
                    RESAMPLE_CHUNK,
                    // `sub_chunks`: a higher value reduces latency at the cost
                    // of slightly more CPU; 2 is rubato's documented default.
                    2,
                    TARGET_CHANNELS,
                )
                .map_err(|e| Error::Resample(e.to_string()))?,
            )
        };
        let planar_in = [
            vec![0.0f32; RESAMPLE_CHUNK],
            vec![0.0f32; RESAMPLE_CHUNK],
        ];
        let planar_out: Vec<Vec<f32>> = (0..TARGET_CHANNELS).map(|_| Vec::new()).collect();
        Ok(Self {
            input_rate,
            input_channels,
            rs,
            planar_in,
            planar_out,
            out_acc: [Vec::with_capacity(8192), Vec::with_capacity(8192)],
            leftover_in: Vec::with_capacity(RESAMPLE_CHUNK * 4),
        })
    }

    /// Feed interleaved f32 samples from the capture ring buffer.
    ///
    /// `interleaved.len()` must be a multiple of `input_channels`. The
    /// method appends resampled planar stereo samples to the internal
    /// output accumulator.
    pub fn push_interleaved(&mut self, interleaved: &[f32]) -> Result<()> {
        // Downmix to stereo (L, R) interleaved into self.leftover_in.
        let ch = self.input_channels;
        debug_assert_eq!(interleaved.len() % ch, 0);
        self.leftover_in.reserve(interleaved.len() * 2 / ch);
        for frame in interleaved.chunks_exact(ch) {
            let (l, r) = downmix_frame(frame);
            self.leftover_in.push(l);
            self.leftover_in.push(r);
        }

        // Drain leftover_in in RESAMPLE_CHUNK-sized stereo chunks.
        let chunk_stereo_len = RESAMPLE_CHUNK * 2;
        while self.leftover_in.len() >= chunk_stereo_len {
            // Split the front of leftover_in into planar L/R.
            for i in 0..RESAMPLE_CHUNK {
                self.planar_in[0][i] = self.leftover_in[i * 2];
                self.planar_in[1][i] = self.leftover_in[i * 2 + 1];
            }
            // Remove consumed samples.
            self.leftover_in.drain(..chunk_stereo_len);

            // Resample (or copy) into planar_out.
            if let Some(rs) = &mut self.rs {
                self.planar_out = rs
                    .process(&self.planar_in, None)
                    .map_err(|e| Error::Resample(e.to_string()))?;
            } else {
                // Rate matches target; just clone (cheap — small chunk).
                self.planar_out = vec![self.planar_in[0].clone(), self.planar_in[1].clone()];
            }
            self.out_acc[0].extend_from_slice(&self.planar_out[0]);
            self.out_acc[1].extend_from_slice(&self.planar_out[1]);
        }
        Ok(())
    }

    /// Attempt to pull exactly `frames_per_channel` samples per channel.
    /// Returns `None` if not enough samples are buffered yet.
    pub fn pull_planar(&mut self, frames_per_channel: usize) -> Option<[Vec<f32>; TARGET_CHANNELS]> {
        if self.out_acc[0].len() < frames_per_channel {
            return None;
        }
        let l: Vec<f32> = self.out_acc[0].drain(..frames_per_channel).collect();
        let r: Vec<f32> = self.out_acc[1].drain(..frames_per_channel).collect();
        Some([l, r])
    }

    pub fn input_rate(&self) -> u32 {
        self.input_rate as u32
    }

    pub fn input_channels(&self) -> u16 {
        self.input_channels as u16
    }
}

/// Downmix a single device-rate frame to a stereo (L, R) pair.
///
/// Matrix (WASAPI channel order KSAUDIO_SPEAKER_*):
/// * 1 ch: mono → duplicate.
/// * 2 ch: passthrough.
/// * 3 ch: L, R, C — fold C at -3 dB into both.
/// * 4+  ch: treat as L, R, C, LFE, Ls, Rs, ...
///   * L_out = L + 0.707 * C + 0.5 * Ls
///   * R_out = R + 0.707 * C + 0.5 * Rs
///   * LFE dropped.
///
/// This is a pragmatic v1 matrix; more elaborate ITU-R BS.775 weighting can
/// be substituted later without touching the surrounding pipeline.
fn downmix_frame(frame: &[f32]) -> (f32, f32) {
    match frame.len() {
        0 => (0.0, 0.0),
        1 => (frame[0], frame[0]),
        2 => (frame[0], frame[1]),
        3 => {
            let c = frame[2] * std::f32::consts::FRAC_1_SQRT_2;
            (frame[0] + c, frame[1] + c)
        }
        _ => {
            // 4+: L R C LFE [Ls Rs ...]
            let l = frame[0];
            let r = frame[1];
            let c = frame[2] * std::f32::consts::FRAC_1_SQRT_2;
            // Skip LFE (idx 3).
            let ls = frame.get(4).copied().unwrap_or(0.0) * 0.5;
            let rs = frame.get(5).copied().unwrap_or(0.0) * 0.5;
            (l + c + ls, r + c + rs)
        }
    }
}
