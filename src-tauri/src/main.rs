// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod commands;
mod hotkey;
mod icons;
mod indexer;
mod launcher;
mod miniapps;
mod picker;
mod search;
mod state;
mod store;
mod system;
mod tray;
mod updater;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(data_dir.join("icons"))?;

            let store = Store::open(&data_dir.join("fyn.db"))?;
            let hotkey = store
                .get_setting("hotkey")
                .unwrap_or_else(|| hotkey::DEFAULT.to_string());
            let theme = commands::saved_theme(&store);

            // Serve the last known catalogue immediately; a fresh scan runs in the background.
            let cached = indexer::cache::load(&data_dir);
            app.manage(AppState::new(data_dir, store, cached, hotkey.clone()));

            clipboard::init(&handle);
            miniapps::init_pomodoro(&handle);
            hotkey::register_initial(&handle, &hotkey);
            tray::create(&handle)?;
            window::install(&handle);
            picker::restore_cursors(); // in case a previous run was killed mid-pick
            window::apply_theme(&handle, &theme);
            state::refresh(&handle);
            watcher::start(&handle);
            commands::enable_autostart_by_default(&handle);
            updater::check_in_background(&handle);

            // Show the launcher on a manual start so the user knows it's running, once the
            // UI has drawn its first frame (no empty panel, no list popping in).
            if !std::env::args().any(|a| a == hotkey::AUTOSTART_FLAG) {
                window::show_when_ready(&handle);
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
            commands::set_onboarded,
            commands::set_search_engine,
            commands::set_theme,
            commands::set_home_layout,
            commands::run_system_command,
            commands::open_settings_page,
            commands::open_url,
            commands::check_path,
            commands::open_path,
            commands::pick_screen_color,
            clipboard::clipboard_status,
            clipboard::set_clipboard_settings,
            clipboard::clipboard_list,
            clipboard::clipboard_image,
            clipboard::clipboard_copy,
            clipboard::clipboard_paste,
            clipboard::clipboard_delete,
            clipboard::clipboard_clear,
            clipboard::clipboard_pause,
            miniapps::clean_settings,
            miniapps::set_clean_settings,
            miniapps::clean_scan,
            miniapps::clean_run,
            miniapps::ports_list,
            miniapps::ports_kill,
            miniapps::copy_secret,
            miniapps::read_clipboard_text,
            miniapps::pomodoro_state,
            miniapps::pomodoro_start,
            miniapps::pomodoro_pause,
            miniapps::pomodoro_skip,
            miniapps::pomodoro_reset,
            miniapps::set_pomodoro_settings,
            miniapps::pomodoro_stats,
            miniapps::pomodoro_clear_history,
            commands::ui_ready,
            commands::check_for_update,
            commands::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fyn");
}
