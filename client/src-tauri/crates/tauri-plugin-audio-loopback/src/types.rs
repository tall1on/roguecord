//! Shared DTOs for the audio-loopback plugin.
//!
//! These structs define the wire-format between the Rust plugin and the
//! TypeScript frontend. Field names are normative — the TS client parses
//! them directly by these identifiers.

use serde::{Deserialize, Serialize};

/// Friendly metadata describing an audio render endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    /// WASAPI endpoint id (e.g. `{0.0.0.00000000}.{...}`). Stable across reboots.
    pub id: String,
    /// Friendly name suitable for the UI device picker.
    pub name: String,
    /// Whether this endpoint is currently the system default render endpoint.
    #[serde(rename = "isDefaultOutput")]
    pub is_default_output: bool,
}

/// Caller-supplied options for starting a new loopback session.
#[derive(Debug, Clone, Deserialize)]
pub struct StartOpts {
    /// Target endpoint id; `None` => use the current default render endpoint.
    #[serde(rename = "deviceId", default)]
    pub device_id: Option<String>,

    /// Opus bitrate in bits per second. Default 128 kbps.
    #[serde(rename = "bitrateBps", default = "default_bitrate")]
    pub bitrate_bps: u32,

    /// Opus frame duration in milliseconds. Valid: 2.5, 5, 10, 20, 40, 60.
    /// The wire representation is an integer number of milliseconds; the
    /// 2.5 ms option is not exposed through this field (out of scope for v1).
    #[serde(rename = "frameDurationMs", default = "default_frame_ms")]
    pub frame_duration_ms: u8,

    /// Opus complexity (0..=10). Default 10.
    #[serde(default = "default_complexity")]
    pub complexity: u8,

    /// Channel count for the emitted Opus stream. Currently locked to 2.
    #[serde(default = "default_channels")]
    pub channels: u8,
}

fn default_bitrate() -> u32 {
    128_000
}
fn default_frame_ms() -> u8 {
    20
}
fn default_complexity() -> u8 {
    10
}
fn default_channels() -> u8 {
    2
}

/// Newtype wrapper around a monotonically-increasing u32 session id.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct SessionId(pub u32);

/// Snapshot of runtime statistics for a session.
#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub session: SessionId,
    #[serde(rename = "framesEmitted")]
    pub frames_emitted: u64,
    #[serde(rename = "framesDroppedRingOverflow")]
    pub frames_dropped_ring_overflow: u64,
    #[serde(rename = "framesDroppedChannelFull")]
    pub frames_dropped_channel_full: u64,
    #[serde(rename = "encoderLatencyUsP50")]
    pub encoder_latency_us_p50: u32,
    #[serde(rename = "encoderLatencyUsP99")]
    pub encoder_latency_us_p99: u32,
    #[serde(rename = "captureDeviceSampleRate")]
    pub capture_device_sample_rate: u32,
    #[serde(rename = "captureDeviceChannels")]
    pub capture_device_channels: u16,
    #[serde(rename = "startedAtUnixMs")]
    pub started_at_unix_ms: i64,
}

/// Lifecycle message delivered over the `state` Tauri channel.
///
/// Serialized as a tagged union: `{ "state": "started" | "stopped" | "error", ... }`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum StateMessage {
    Started {
        session: SessionId,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "deviceName")]
        device_name: String,
        #[serde(rename = "deviceSampleRate")]
        device_sample_rate: u32,
        #[serde(rename = "deviceChannels")]
        device_channels: u16,
    },
    Stopped {
        session: SessionId,
        reason: String,
    },
    Error {
        session: SessionId,
        error: String,
    },
}

/// ALF1 binary frame header magic (ASCII `ALF1` as a little-endian u32).
pub const ALF1_MAGIC: [u8; 4] = *b"ALF1";

/// Total size of the ALF1 frame header in bytes.
pub const ALF1_HEADER_SIZE: usize = 16;

/// Build the 16-byte ALF1 frame header.
///
/// Layout (all little-endian):
///
/// ```text
/// offset  size  field
/// ------  ----  -----
/// 0        4    magic         = b"ALF1"
/// 4        4    session_id    u32 LE
/// 8        4    seq           u32 LE
/// 12       4    timestamp_us  u32 LE
/// ```
#[inline]
pub fn encode_frame_header(session_id: u32, seq: u32, timestamp_us: u32) -> [u8; ALF1_HEADER_SIZE] {
    let mut out = [0u8; ALF1_HEADER_SIZE];
    out[0..4].copy_from_slice(&ALF1_MAGIC);
    out[4..8].copy_from_slice(&session_id.to_le_bytes());
    out[8..12].copy_from_slice(&seq.to_le_bytes());
    out[12..16].copy_from_slice(&timestamp_us.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_layout() {
        let h = encode_frame_header(0x1122_3344, 0x0A0B_0C0D, 0xAABB_CCDD);
        assert_eq!(&h[0..4], b"ALF1");
        assert_eq!(&h[4..8], &[0x44, 0x33, 0x22, 0x11]);
        assert_eq!(&h[8..12], &[0x0D, 0x0C, 0x0B, 0x0A]);
        assert_eq!(&h[12..16], &[0xDD, 0xCC, 0xBB, 0xAA]);
    }
}
