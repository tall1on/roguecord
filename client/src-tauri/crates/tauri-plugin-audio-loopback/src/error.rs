//! Error type for the audio-loopback plugin.
//!
//! Serialized to the frontend as a tagged union so the TypeScript
//! client can discriminate by `kind` and render the `message`.

use crate::types::SessionId;

/// All failures surfaced through Tauri commands or lifecycle events.
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum Error {
    /// Feature is not supported on the current platform (non-Windows builds).
    #[error("audio-loopback is not supported on this platform")]
    Unsupported,

    /// Attempted to start a second session while one is already active.
    #[error("a loopback session is already running")]
    AlreadyRunning,

    /// The requested session id does not match the active session.
    #[error("no loopback session with id {0:?}")]
    UnknownSession(SessionId),

    /// No default render endpoint was available.
    #[error("no default render endpoint")]
    NoDefaultDevice,

    /// A device id was provided but no matching endpoint exists.
    #[error("device not found: {0}")]
    DeviceNotFound(String),

    /// A WASAPI call failed. Contains the stringified HRESULT / message.
    #[error("WASAPI error: {0}")]
    Wasapi(String),

    /// Resampler construction or processing failed.
    #[error("resampler error: {0}")]
    Resample(String),

    /// Opus encoder reported an error.
    #[error("opus encoder error: {0}")]
    Opus(String),

    /// Caller supplied an invalid option value.
    #[error("invalid option: {0}")]
    InvalidOption(String),

    /// Catch-all for unexpected internal errors.
    #[error("internal error: {0}")]
    Internal(String),
}

/// Convenience `Result` alias used throughout the plugin.
pub type Result<T> = std::result::Result<T, Error>;
