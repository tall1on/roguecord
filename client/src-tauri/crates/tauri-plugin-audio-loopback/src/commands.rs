//! Thin `#[tauri::command]` wrappers around [`crate::session::SessionManager`].
//!
//! All heavy lifting lives in the session manager and the platform-specific
//! capture / encode modules. These functions exist only to shuttle arguments
//! and results between the IPC layer and the manager.

use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::Result;
use crate::session::SessionManager;
use crate::types::{DeviceInfo, SessionId, StartOpts, StateMessage, Stats};

/// Enumerate available audio render endpoints.
#[tauri::command]
pub async fn audio_loopback_list_devices(
    session_mgr: tauri::State<'_, Arc<SessionManager>>,
) -> Result<Vec<DeviceInfo>> {
    session_mgr.list_devices()
}

/// Start a new WASAPI loopback + Opus encoding session.
///
/// Binary Opus frames (ALF1-framed) are delivered on `frames`; JSON
/// lifecycle messages on `state`. See [`crate::types::encode_frame_header`].
#[tauri::command]
pub async fn audio_loopback_start(
    opts: StartOpts,
    frames: Channel<InvokeResponseBody>,
    state: Channel<StateMessage>,
    session_mgr: tauri::State<'_, Arc<SessionManager>>,
) -> Result<SessionId> {
    // `State` dereferences to our stored `Arc<SessionManager>`; clone the
    // inner `Arc` so the call site (and any spawned threads) can hold
    // a stable owning handle independent of the request lifetime.
    let mgr: Arc<SessionManager> = Arc::clone(&*session_mgr);
    mgr.start(opts, frames, state)
}

/// Stop the session matching `session`. Idempotent: returns
/// `UnknownSession` if nothing is running under that id.
#[tauri::command]
pub async fn audio_loopback_stop(
    session: SessionId,
    session_mgr: tauri::State<'_, Arc<SessionManager>>,
) -> Result<()> {
    session_mgr.stop(session)
}

/// Fetch current runtime statistics for the active session.
#[tauri::command]
pub async fn audio_loopback_stats(
    session: SessionId,
    session_mgr: tauri::State<'_, Arc<SessionManager>>,
) -> Result<Stats> {
    session_mgr.stats(session)
}
