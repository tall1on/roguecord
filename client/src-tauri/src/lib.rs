//! RogueCord Tauri shell library.
//!
//! Thin entrypoint: instantiates the Tauri application and registers
//! the [`tauri_plugin_audio_loopback`] plugin.

/// Build and run the Tauri application.
///
/// This is kept minimal on purpose; all feature logic lives in
/// dedicated plugins / subcrates.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_audio_loopback::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
