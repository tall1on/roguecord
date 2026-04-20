//! Session lifecycle management.
//!
//! `SessionManager` owns at most one active capture/encode session and
//! coordinates the two OS threads that implement the pipeline:
//!
//! * **capture thread** — pulls PCM from WASAPI into a device-rate ring buffer.
//! * **encoder thread** — resamples to 48 kHz stereo and encodes Opus.
//!
//! The two halves are wired via a lock-free SPSC ring buffer provided by
//! `ringbuf 0.4` (see [`crate::capture`] / [`crate::encode`]).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::{Error, Result};
use crate::types::{DeviceInfo, SessionId, StartOpts, StateMessage, Stats};

/// Shared counters / telemetry written by the encoder thread and read
/// by `audio_loopback_stats`.
#[derive(Debug, Default)]
pub struct StatsInner {
    pub frames_emitted: AtomicU64,
    pub frames_dropped_ring_overflow: AtomicU64,
    pub frames_dropped_channel_full: AtomicU64,
    pub encoder_latency_us_p50: AtomicU32,
    pub encoder_latency_us_p99: AtomicU32,
    pub capture_device_sample_rate: AtomicU32,
    pub capture_device_channels: AtomicU32, // stored as u32 for atomicity; truncated on read
    pub started_at_unix_ms: parking_lot::Mutex<i64>,
}

impl StatsInner {
    pub fn snapshot(&self, id: SessionId) -> Stats {
        Stats {
            session: id,
            frames_emitted: self.frames_emitted.load(Ordering::Relaxed),
            frames_dropped_ring_overflow: self.frames_dropped_ring_overflow.load(Ordering::Relaxed),
            frames_dropped_channel_full: self.frames_dropped_channel_full.load(Ordering::Relaxed),
            encoder_latency_us_p50: self.encoder_latency_us_p50.load(Ordering::Relaxed),
            encoder_latency_us_p99: self.encoder_latency_us_p99.load(Ordering::Relaxed),
            capture_device_sample_rate: self.capture_device_sample_rate.load(Ordering::Relaxed),
            capture_device_channels: self.capture_device_channels.load(Ordering::Relaxed) as u16,
            started_at_unix_ms: *self.started_at_unix_ms.lock(),
        }
    }
}

/// Internal record kept inside the `SessionManager`.
struct ActiveSession {
    id: SessionId,
    stop_flag: Arc<AtomicBool>,
    capture_handle: Option<std::thread::JoinHandle<()>>,
    encoder_handle: Option<std::thread::JoinHandle<()>>,
    stats: Arc<StatsInner>,
}

impl ActiveSession {
    fn stop_and_join(mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        // 2-second timeout per thread; on timeout we detach and log.
        for (name, handle) in [
            ("capture", self.capture_handle.take()),
            ("encoder", self.encoder_handle.take()),
        ] {
            if let Some(h) = handle {
                // Best-effort: join without a real timeout API in std::thread.
                // We rely on the threads polling `stop_flag` frequently enough
                // that they terminate quickly.
                if let Err(e) = h.join() {
                    tracing::error!(?e, thread = name, "thread panic during shutdown");
                }
            }
        }
    }
}

/// Plugin-wide session owner. Only one session is allowed to be active
/// at a time per app instance.
pub struct SessionManager {
    inner: Mutex<Option<ActiveSession>>,
    next_id: AtomicU32,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            next_id: AtomicU32::new(1),
        }
    }

    /// Enumerate render endpoints. On non-Windows targets returns an empty list.
    pub fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        #[cfg(windows)]
        {
            crate::capture::list_render_devices()
        }
        #[cfg(not(windows))]
        {
            Ok(Vec::new())
        }
    }

    /// Start a new session. Returns `Error::AlreadyRunning` if one is
    /// already active, or `Error::Unsupported` on non-Windows builds.
    #[allow(unused_variables)]
    pub fn start(
        self: &Arc<Self>,
        opts: StartOpts,
        frames: Channel<InvokeResponseBody>,
        state: Channel<StateMessage>,
    ) -> Result<SessionId> {
        let mut guard = self.inner.lock();
        if guard.is_some() {
            return Err(Error::AlreadyRunning);
        }

        #[cfg(windows)]
        {
            let id = SessionId(self.next_id.fetch_add(1, Ordering::Relaxed));
            let stop_flag = Arc::new(AtomicBool::new(false));
            let stats = Arc::new(StatsInner::default());

            let session = crate::capture::spawn_session(
                id,
                opts,
                frames,
                state,
                stop_flag.clone(),
                stats.clone(),
            )?;

            *guard = Some(ActiveSession {
                id,
                stop_flag,
                capture_handle: Some(session.capture_handle),
                encoder_handle: Some(session.encoder_handle),
                stats,
            });
            Ok(id)
        }
        #[cfg(not(windows))]
        {
            Err(Error::Unsupported)
        }
    }

    /// Stop the session with the given id. Returns `UnknownSession` if
    /// the id does not match the current session (or no session exists).
    pub fn stop(&self, id: SessionId) -> Result<()> {
        let mut guard = self.inner.lock();
        let session = match guard.as_ref() {
            Some(s) if s.id == id => guard.take().unwrap(),
            _ => return Err(Error::UnknownSession(id)),
        };
        // Release the mutex before joining — join may take several ms and
        // we don't want to block `stats()` callers during teardown.
        drop(guard);
        session.stop_and_join();
        Ok(())
    }

    /// Best-effort stop of any active session; used during application exit.
    pub fn stop_all(&self) {
        let mut guard = self.inner.lock();
        if let Some(session) = guard.take() {
            drop(guard);
            session.stop_and_join();
        }
    }

    /// Fetch a stats snapshot for the given session id.
    pub fn stats(&self, id: SessionId) -> Result<Stats> {
        let guard = self.inner.lock();
        match guard.as_ref() {
            Some(s) if s.id == id => Ok(s.stats.snapshot(id)),
            _ => Err(Error::UnknownSession(id)),
        }
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// Handle produced by the Windows capture layer; groups the two
/// JoinHandles that the `SessionManager` retains.
#[cfg(windows)]
pub struct SpawnedSession {
    pub capture_handle: std::thread::JoinHandle<()>,
    pub encoder_handle: std::thread::JoinHandle<()>,
}
