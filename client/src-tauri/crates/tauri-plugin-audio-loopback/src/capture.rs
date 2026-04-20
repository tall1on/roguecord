//! Windows WASAPI loopback capture.
//!
//! This module is compiled only on Windows (`#[cfg(windows)]`). It spawns
//! two OS threads for each active session:
//!
//! 1. **capture**  — pulls PCM from WASAPI loopback into a device-rate ring buffer.
//! 2. **encoder**  — resamples to 48 kHz stereo and encodes Opus, sending
//!    ALF1-framed packets back to the frontend via the Tauri IPC channel.
//!
//! Shared state between the threads:
//!
//! * `ringbuf::HeapRb<f32>` — SPSC lock-free ring buffer holding interleaved
//!   device-rate f32 PCM samples. Capacity sized for ~200 ms of audio.
//! * `Arc<AtomicBool>` — stop flag polled every iteration.
//! * `Arc<StatsInner>` — telemetry counters updated by both threads.
//!
//! The `wasapi` crate 0.17 is used for all WASAPI bindings.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::encode::{EncoderConfig, FrameEncoder};
use crate::error::{Error, Result};
use crate::resample::ResamplePipeline;
use crate::session::{SpawnedSession, StatsInner};
use crate::types::{DeviceInfo, SessionId, StartOpts, StateMessage};

use wasapi::{
    get_default_device, initialize_mta, DeviceCollection, Direction, SampleType, ShareMode,
};

/// Ring buffer capacity: 200 ms at 48 kHz stereo. Sized for the 48 kHz
/// mix-format case — higher device rates (e.g. 192 kHz) buffer less
/// wall-clock but still comfortably more than WASAPI's ~10 ms event period.
const RING_CAPACITY_SAMPLES: usize = 48_000 * 2 * 200 / 1000;

/// Enumerate all render endpoints using the WASAPI device collection API.
pub fn list_render_devices() -> Result<Vec<DeviceInfo>> {
    // COM must be initialized for each thread that touches WASAPI.
    // `initialize_mta` is idempotent on success and only fails if the
    // thread is already COM-initialized as STA — non-fatal for us.
    initialize_mta().ok();

    let collection = DeviceCollection::new(&Direction::Render)
        .map_err(|e| Error::Wasapi(format!("DeviceCollection::new: {e}")))?;
    let count = collection
        .get_nbr_devices()
        .map_err(|e| Error::Wasapi(format!("get_nbr_devices: {e}")))?;

    let default_id = get_default_device(&Direction::Render)
        .ok()
        .and_then(|d| d.get_id().ok());

    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let dev = collection
            .get_device_at_index(i)
            .map_err(|e| Error::Wasapi(format!("get_device_at_index({i}): {e}")))?;
        let id = dev
            .get_id()
            .map_err(|e| Error::Wasapi(format!("get_id: {e}")))?;
        let name = dev
            .get_friendlyname()
            .unwrap_or_else(|_| format!("Output ({})", short_id(&id)));
        let is_default = default_id.as_deref() == Some(id.as_str());
        out.push(DeviceInfo {
            id,
            name,
            is_default_output: is_default,
        });
    }
    Ok(out)
}

fn short_id(id: &str) -> String {
    // Pull the tail of the endpoint id as a human-readable suffix.
    let suffix: String = id.chars().rev().take(8).collect();
    suffix.chars().rev().collect()
}

/// Resolve an endpoint by its WASAPI id string, or fall back to the
/// default render endpoint if `target` is `None`.
fn resolve_device(target: Option<&str>) -> Result<wasapi::Device> {
    match target {
        None => get_default_device(&Direction::Render).map_err(|_| Error::NoDefaultDevice),
        Some(target) => {
            let collection = DeviceCollection::new(&Direction::Render)
                .map_err(|e| Error::Wasapi(format!("DeviceCollection::new: {e}")))?;
            let count = collection
                .get_nbr_devices()
                .map_err(|e| Error::Wasapi(format!("get_nbr_devices: {e}")))?;
            for i in 0..count {
                let dev = collection
                    .get_device_at_index(i)
                    .map_err(|e| Error::Wasapi(format!("get_device_at_index({i}): {e}")))?;
                if dev.get_id().ok().as_deref() == Some(target) {
                    return Ok(dev);
                }
            }
            Err(Error::DeviceNotFound(target.to_string()))
        }
    }
}

/// Spawn the capture + encode pipeline for a new session.
pub fn spawn_session(
    id: SessionId,
    opts: StartOpts,
    frames_ch: Channel<InvokeResponseBody>,
    state_ch: Channel<StateMessage>,
    stop_flag: Arc<AtomicBool>,
    stats: Arc<StatsInner>,
) -> Result<SpawnedSession> {
    initialize_mta().ok();

    // Validate device up-front so the Tauri command can surface
    // device-not-found errors synchronously.
    let device = resolve_device(opts.device_id.as_deref())?;
    let device_id = device
        .get_id()
        .map_err(|e| Error::Wasapi(format!("get_id: {e}")))?;
    let device_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| format!("Output ({})", short_id(&device_id)));

    // Build the shared ring buffer on the caller thread.
    let rb = HeapRb::<f32>::new(RING_CAPACITY_SAMPLES);
    let (producer, consumer) = rb.split();

    let stats_cap = Arc::clone(&stats);
    let stats_enc = Arc::clone(&stats);
    let stop_cap = Arc::clone(&stop_flag);
    let stop_enc = Arc::clone(&stop_flag);
    let state_cap_primary = state_ch.clone();
    let state_cap_error = state_ch.clone();
    let state_enc = state_ch;

    let enc_cfg = EncoderConfig {
        bitrate_bps: opts.bitrate_bps,
        frame_duration_ms: opts.frame_duration_ms,
        complexity: opts.complexity,
    };
    let target_device_id = device_id.clone();
    let target_device_name = device_name.clone();

    // Record the start time as soon as we're sure we'll spawn.
    *stats.started_at_unix_ms.lock() = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let capture_handle = std::thread::Builder::new()
        .name("alf-capture".to_string())
        .spawn(move || {
            if let Err(e) = run_capture(
                target_device_id,
                producer,
                stop_cap,
                stats_cap,
                state_cap_primary,
                id,
            ) {
                tracing::error!(error = %e, "capture thread exited with error");
                let _ = state_cap_error.send(StateMessage::Error {
                    session: id,
                    error: e.to_string(),
                });
            }
        })
        .map_err(|e| Error::Internal(format!("failed to spawn capture thread: {e}")))?;

    let state_enc_error = state_enc.clone();
    let encoder_handle = std::thread::Builder::new()
        .name("alf-encode".to_string())
        .spawn(move || {
            if let Err(e) = run_encoder(
                id,
                enc_cfg,
                consumer,
                frames_ch,
                state_enc,
                stop_enc,
                stats_enc,
                target_device_name,
                device_id,
            ) {
                tracing::error!(error = %e, "encoder thread exited with error");
                let _ = state_enc_error.send(StateMessage::Error {
                    session: id,
                    error: e.to_string(),
                });
            }
        })
        .map_err(|e| Error::Internal(format!("failed to spawn encoder thread: {e}")))?;

    Ok(SpawnedSession {
        capture_handle,
        encoder_handle,
    })
}

/// Capture-thread entrypoint.
fn run_capture(
    device_id: String,
    mut producer: HeapProd<f32>,
    stop_flag: Arc<AtomicBool>,
    stats: Arc<StatsInner>,
    _state_ch: Channel<StateMessage>,
    _session: SessionId,
) -> Result<()> {
    // SAFETY: COM init is mandatory per thread that calls WASAPI.
    initialize_mta().ok();

    // Resolve the device on the capture thread: device/client COM pointers
    // are safest to construct on the thread that will use them.
    let device = resolve_device(Some(&device_id))?;

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| Error::Wasapi(format!("get_iaudioclient: {e}")))?;

    let mix_format = audio_client
        .get_mixformat()
        .map_err(|e| Error::Wasapi(format!("get_mixformat: {e}")))?;

    let sample_rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels();
    let bytes_per_sample = (mix_format.get_bitspersample() / 8) as usize;
    let sample_type = mix_format.get_subformat().unwrap_or(SampleType::Float);

    stats
        .capture_device_sample_rate
        .store(sample_rate, Ordering::Relaxed);
    stats
        .capture_device_channels
        .store(channels as u32, Ordering::Relaxed);

    // Initialize as LOOPBACK capture in SHARED mode with event-driven
    // callbacks. Loopback is opened against a render endpoint but uses
    // `Direction::Capture` in wasapi 0.17's API.
    audio_client
        .initialize_client(
            &mix_format,
            0, // use default buffer duration
            &Direction::Capture,
            &ShareMode::Shared,
            true, // loopback
        )
        .map_err(|e| Error::Wasapi(format!("initialize_client: {e}")))?;

    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|e| Error::Wasapi(format!("set_get_eventhandle: {e}")))?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| Error::Wasapi(format!("get_audiocaptureclient: {e}")))?;

    audio_client
        .start_stream()
        .map_err(|e| Error::Wasapi(format!("start_stream: {e}")))?;

    let mut raw_bytes: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    let mut f32_scratch: Vec<f32> = Vec::with_capacity(8192);

    // 200 ms covers any plausible stall; 3 consecutive timeouts = hard fail.
    let wait_timeout_ms: u32 = 200;
    let mut consecutive_timeouts = 0u32;

    while !stop_flag.load(Ordering::Relaxed) {
        match event_handle.wait_for_event(wait_timeout_ms) {
            Ok(()) => consecutive_timeouts = 0,
            Err(_) => {
                consecutive_timeouts += 1;
                if consecutive_timeouts >= 3 {
                    return Err(Error::Wasapi(
                        "wait_for_event timed out 3 times consecutively".to_string(),
                    ));
                }
                continue;
            }
        }

        capture_client
            .read_from_device_to_deque(&mut raw_bytes)
            .map_err(|e| Error::Wasapi(format!("read_from_device_to_deque: {e}")))?;

        if raw_bytes.is_empty() {
            continue;
        }

        f32_scratch.clear();
        convert_samples(&sample_type, bytes_per_sample, &raw_bytes, &mut f32_scratch);
        raw_bytes.clear();

        if f32_scratch.is_empty() {
            continue;
        }

        // Overflow policy: drop the OLDEST samples in the ring so the
        // encoder always sees the freshest audio. We achieve this by
        // reading (skipping) samples from the consumer side? — but the
        // consumer thread owns that half. Simpler and lock-free: when
        // the producer can't fit the incoming chunk, trim from the front
        // of the *incoming* chunk (dropping the oldest of the new batch).
        // Over time this behaves similarly to dropping oldest buffered.
        let free = producer.vacant_len();
        let to_push = f32_scratch.len();
        if to_push > free {
            let overflow = to_push - free;
            stats
                .frames_dropped_ring_overflow
                .fetch_add(overflow as u64 / (channels as u64).max(1), Ordering::Relaxed);
            producer.push_slice(&f32_scratch[overflow..]);
        } else {
            producer.push_slice(&f32_scratch);
        }
    }

    audio_client
        .stop_stream()
        .map_err(|e| Error::Wasapi(format!("stop_stream: {e}")))?;
    Ok(())
}

/// Decode an arbitrary WASAPI byte stream into f32 samples.
///
/// Handles the three common WASAPI mix-format variants:
/// float32, int16, int24-packed, int32. Unknown formats emit silence
/// (same sample count) so that sample-alignment is preserved downstream.
fn convert_samples(
    sample_type: &SampleType,
    bytes_per_sample: usize,
    src: &std::collections::VecDeque<u8>,
    dst: &mut Vec<f32>,
) {
    let (a, b) = src.as_slices();
    let mut handle = |chunk: &[u8]| match (sample_type, bytes_per_sample) {
        (SampleType::Float, 4) => {
            for bytes in chunk.chunks_exact(4) {
                dst.push(f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
            }
        }
        (SampleType::Int, 2) => {
            for bytes in chunk.chunks_exact(2) {
                let v = i16::from_le_bytes([bytes[0], bytes[1]]);
                dst.push(v as f32 / i16::MAX as f32);
            }
        }
        (SampleType::Int, 3) => {
            for bytes in chunk.chunks_exact(3) {
                // 24-bit little-endian, sign-extended to i32.
                let mut v =
                    (bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
                if v & 0x0080_0000 != 0 {
                    v |= -0x0100_0000_i32;
                }
                dst.push(v as f32 / 8_388_607.0);
            }
        }
        (SampleType::Int, 4) => {
            for bytes in chunk.chunks_exact(4) {
                let v = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                dst.push(v as f32 / i32::MAX as f32);
            }
        }
        _ => {
            for _ in chunk.chunks_exact(bytes_per_sample.max(1)) {
                dst.push(0.0);
            }
        }
    };
    handle(a);
    handle(b);
}

/// Encoder-thread entrypoint.
#[allow(clippy::too_many_arguments)]
fn run_encoder(
    session_id: SessionId,
    cfg: EncoderConfig,
    mut consumer: HeapCons<f32>,
    frames_ch: Channel<InvokeResponseBody>,
    state_ch: Channel<StateMessage>,
    stop_flag: Arc<AtomicBool>,
    stats: Arc<StatsInner>,
    device_name: String,
    device_id: String,
) -> Result<()> {
    // Wait briefly for the capture thread to publish device format.
    let (mut rate, mut channels) = (0u32, 0u16);
    for _ in 0..50 {
        rate = stats.capture_device_sample_rate.load(Ordering::Relaxed);
        channels = stats.capture_device_channels.load(Ordering::Relaxed) as u16;
        if rate > 0 && channels > 0 {
            break;
        }
        if stop_flag.load(Ordering::Relaxed) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if rate == 0 || channels == 0 {
        return Err(Error::Wasapi(
            "capture thread failed to initialize device format".to_string(),
        ));
    }

    let mut pipeline = ResamplePipeline::new(rate, channels)?;
    let mut encoder = FrameEncoder::new(session_id, &cfg, frames_ch, Arc::clone(&stats))?;

    let _ = state_ch.send(StateMessage::Started {
        session: session_id,
        device_id,
        device_name,
        device_sample_rate: rate,
        device_channels: channels,
    });

    let frame_len = encoder.frame_samples_per_channel();
    // Preallocate consumer scratch big enough to drain in one call.
    let mut scratch: Vec<f32> = vec![0.0; 8192];

    while !stop_flag.load(Ordering::Relaxed) {
        // `pop_slice` writes into an initialized slice and returns the
        // number of samples actually written — no unsafe needed.
        let drained = consumer.pop_slice(&mut scratch);
        if drained > 0 {
            pipeline.push_interleaved(&scratch[..drained])?;
        }

        let mut emitted = 0;
        while let Some(frame) = pipeline.pull_planar(frame_len) {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            encoder.encode_and_send(frame)?;
            emitted += 1;
            if emitted > 32 {
                // Don't monopolise the thread — re-check stop_flag between
                // large catch-up batches.
                break;
            }
        }

        if drained == 0 && emitted == 0 {
            // Idle tick; sleep sub-frame to avoid a tight spin.
            std::thread::sleep(Duration::from_micros(500));
        }
    }

    let _ = state_ch.send(StateMessage::Stopped {
        session: session_id,
        reason: "stopped by user".to_string(),
    });
    Ok(())
}
