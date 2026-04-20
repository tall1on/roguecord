//! `tauri-plugin-audio-loopback` — WASAPI system-audio loopback capture plus
//! Opus encoding, surfaced to the webview over Tauri v2 IPC channels.
//!
//! See `docs/system-audio-loopback-design.md` for the authoritative spec.
//!
//! The plugin registers four commands:
//!
//! | Command                          | Description                                   |
//! | -------------------------------- | --------------------------------------------- |
//! | `audio_loopback_list_devices`    | Enumerate render endpoints.                   |
//! | `audio_loopback_start`           | Start a loopback capture + encode session.    |
//! | `audio_loopback_stop`            | Stop an active session.                       |
//! | `audio_loopback_stats`           | Fetch runtime statistics for the session.     |
//!
//! On non-Windows targets all commands (except a trivially-empty
//! `list_devices`) return [`error::Error::Unsupported`].

pub mod commands;
pub mod error;
pub mod session;
pub mod types;

// Platform-specific capture implementation.
#[cfg(windows)]
pub mod capture;
#[cfg(windows)]
pub mod encode;
#[cfg(windows)]
pub mod resample;

use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::Error;
pub use types::{DeviceInfo, SessionId, StartOpts, StateMessage, Stats};

/// Plugin name as referenced by Tauri's permission system
/// (`plugin:audio-loopback|<command>`).
pub const PLUGIN_NAME: &str = "audio-loopback";

/// Build the Tauri plugin.
///
/// Registers the [`session::SessionManager`] as shared application state
/// and wires the four `audio_loopback_*` commands.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            commands::audio_loopback_list_devices,
            commands::audio_loopback_start,
            commands::audio_loopback_stop,
            commands::audio_loopback_stats,
        ])
        .setup(|app, _api| {
            let mgr = Arc::new(session::SessionManager::new());
            app.manage(mgr);
            Ok(())
        })
        .on_event(|app, event| {
            // Stop any active session when the app is exiting so that
            // capture / encoder threads join cleanly before teardown.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(mgr) = app.try_state::<Arc<session::SessionManager>>() {
                    mgr.stop_all();
                }
            }
        })
        .build()
}
