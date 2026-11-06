// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod hotkey;
mod icons;
mod indexer;
mod launcher;
mod search;
mod state;
mod store;
mod tray;
mod watcher;
mod win;
mod window;

use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

use crate::state::AppState;
use crate::store::Store;

fn main() {
    tauri::Builder::default()
        // Must be registered first: a second launch just reveals the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![hotkey::AUTOSTART_FLAG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        window::toggle(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(data_dir.join("icons"))?;

            let store = Store::open(&data_dir.join("fyn.db"))?;
            let hotkey = store
                .get_setting("hotkey")
                .unwrap_or_else(|| hotkey::DEFAULT.to_string());

            // Serve the last known catalogue immediately; a fresh scan runs in the background.
            let cached = indexer::cache::load(&data_dir);
            app.manage(AppState::new(data_dir, store, cached, hotkey.clone()));

            hotkey::register_initial(&handle, &hotkey);
            tray::create(&handle)?;
            window::install(&handle);
            state::refresh(&handle);
            watcher::start(&handle);

            // Show the launcher on a manual start so the user knows it's running.
            if !std::env::args().any(|a| a == hotkey::AUTOSTART_FLAG) {
                window::show(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_home,
            commands::search,
            commands::launch,
            commands::reveal,
            commands::toggle_pin,
            commands::move_pin,
            commands::hide_window,
            commands::get_settings,
            commands::set_hotkey,
            commands::suspend_hotkey,
            commands::set_autostart,
            commands::rescan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fyn");
}
