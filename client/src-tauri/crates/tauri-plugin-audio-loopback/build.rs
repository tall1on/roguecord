//! Build script for the `tauri-plugin-audio-loopback` plugin.
//!
//! Uses `tauri-plugin` build helpers to generate the plugin's permission
//! schemas from the files under `permissions/` at compile time.

const COMMANDS: &[&str] = &[
    "audio_loopback_list_devices",
    "audio_loopback_start",
    "audio_loopback_stop",
    "audio_loopback_stats",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
