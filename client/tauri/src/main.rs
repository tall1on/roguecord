#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // On CachyOS (and other Linux distros using WebKitGTK), disable the
    // DMA-BUF renderer to avoid rendering issues with certain GPU drivers.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
