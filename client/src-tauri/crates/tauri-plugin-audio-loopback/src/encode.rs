//! Opus encoder wrapper.
//!
//! Wraps [`audiopus::coder::Encoder`] with the project defaults (stereo
//! @ 48 kHz, AUDIO application, VBR, FEC on, DTX off) and emits ALF1-framed
//! packets through a Tauri IPC channel.
//!
//! Compiled on Windows only because it is consumed exclusively by the
//! WASAPI capture path ([`crate::capture`]).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use audiopus::coder::Encoder as OpusEncoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::{Error, Result};
use crate::session::StatsInner;
use crate::types::{encode_frame_header, SessionId, ALF1_HEADER_SIZE};

/// Maximum Opus packet size per RFC 7845 §3 — we over-allocate for safety.
pub const MAX_OPUS_PACKET: usize = 4000;

/// Configuration knobs propagated from [`crate::types::StartOpts`].
pub struct EncoderConfig {
    pub bitrate_bps: u32,
    pub frame_duration_ms: u8,
    pub complexity: u8,
}

/// Stateful Opus encoder wrapper.
pub struct FrameEncoder {
    session_id: SessionId,
    frame_samples_per_channel: usize,
    opus: OpusEncoder,
    seq: u32,
    frames_sent: u64,
    frame_duration_us: u32,
    packet_buf: Vec<u8>,
    pcm_scratch: Vec<f32>, // interleaved stereo f32 fed to audiopus
    frames: Channel<InvokeResponseBody>,
    stats: Arc<StatsInner>,
}

impl FrameEncoder {
    pub fn new(
        session_id: SessionId,
        cfg: &EncoderConfig,
        frames: Channel<InvokeResponseBody>,
        stats: Arc<StatsInner>,
    ) -> Result<Self> {
        let mut opus = OpusEncoder::new(SampleRate::Hz48000, Channels::Stereo, Application::Audio)
            .map_err(|e| Error::Opus(e.to_string()))?;
        opus.set_bitrate(Bitrate::BitsPerSecond(cfg.bitrate_bps as i32))
            .map_err(|e| Error::Opus(e.to_string()))?;
        opus.set_vbr(true).map_err(|e| Error::Opus(e.to_string()))?;
        // FEC on, DTX off, AUDIO application.
        opus.set_inband_fec(true)
            .map_err(|e| Error::Opus(e.to_string()))?;
        opus.set_dtx(false).map_err(|e| Error::Opus(e.to_string()))?;
        let complexity = cfg.complexity.min(10) as i32;
        opus.set_complexity(complexity)
            .map_err(|e| Error::Opus(e.to_string()))?;

        let frame_duration_us = (cfg.frame_duration_ms as u32) * 1_000;
        let frame_samples_per_channel = match cfg.frame_duration_ms {
            5 => 240,
            10 => 480,
            20 => 960,
            40 => 1920,
            60 => 2880,
            // 2.5 ms is not represented as a u8 and is unsupported in v1.
            other => {
                return Err(Error::InvalidOption(format!(
                    "unsupported frame duration: {other}ms"
                )))
            }
        };

        Ok(Self {
            session_id,
            frame_samples_per_channel,
            opus,
            seq: 0,
            frames_sent: 0,
            frame_duration_us,
            packet_buf: vec![0u8; MAX_OPUS_PACKET],
            pcm_scratch: vec![0.0; frame_samples_per_channel * 2],
            frames,
            stats,
        })
    }

    pub fn frame_samples_per_channel(&self) -> usize {
        self.frame_samples_per_channel
    }

    /// Encode one planar-stereo PCM frame and emit it on the frames channel.
    ///
    /// `planar[0]` is L, `planar[1]` is R. Both must have exactly
    /// `frame_samples_per_channel` entries.
    pub fn encode_and_send(&mut self, planar: [Vec<f32>; 2]) -> Result<()> {
        debug_assert_eq!(planar[0].len(), self.frame_samples_per_channel);
        debug_assert_eq!(planar[1].len(), self.frame_samples_per_channel);

        // Interleave into the scratch buffer.
        for i in 0..self.frame_samples_per_channel {
            self.pcm_scratch[i * 2] = planar[0][i];
            self.pcm_scratch[i * 2 + 1] = planar[1][i];
        }

        let started = Instant::now();
        let n = self
            .opus
            .encode_float(&self.pcm_scratch, &mut self.packet_buf)
            .map_err(|e| Error::Opus(e.to_string()))?;
        let elapsed_us = started.elapsed().as_micros().min(u32::MAX as u128) as u32;
        // Simple min-of-max tracking for now; proper reservoir sampling is
        // deferred (see design doc §8.5).
        update_latency_est(&self.stats, elapsed_us);

        // Monotonic sample-clock timestamp, wraps at u32::MAX.
        let timestamp_us = ((self.frames_sent as u128)
            .wrapping_mul(self.frame_duration_us as u128)
            & u32::MAX as u128) as u32;
        let header = encode_frame_header(self.session_id.0, self.seq, timestamp_us);

        let mut out = Vec::with_capacity(ALF1_HEADER_SIZE + n);
        out.extend_from_slice(&header);
        out.extend_from_slice(&self.packet_buf[..n]);

        match self.frames.send(InvokeResponseBody::Raw(out)) {
            Ok(()) => {
                self.stats.frames_emitted.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                // Treat send errors as "receiver dropped / saturated"; log
                // at most occasionally to avoid spamming.
                self.stats
                    .frames_dropped_channel_full
                    .fetch_add(1, Ordering::Relaxed);
                tracing::warn!(?e, "frames channel send failed — receiver gone or slow");
            }
        }

        self.seq = self.seq.wrapping_add(1);
        self.frames_sent = self.frames_sent.wrapping_add(1);
        Ok(())
    }
}

/// Coarse latency tracker: store the most recent sample in the p50 slot
/// and the running max in the p99 slot. A real reservoir sampler is tracked
/// in design-doc §8.5 as a deferred item.
fn update_latency_est(stats: &StatsInner, sample_us: u32) {
    stats
        .encoder_latency_us_p50
        .store(sample_us, Ordering::Relaxed);
    let prev = stats.encoder_latency_us_p99.load(Ordering::Relaxed);
    if sample_us > prev {
        stats
            .encoder_latency_us_p99
            .store(sample_us, Ordering::Relaxed);
    }
}
