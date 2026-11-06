//! Global, user-configurable activation shortcut.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::state::AppState;

pub const DEFAULT: &str = "Ctrl+Space";
pub const AUTOSTART_FLAG: &str = "--autostart";
const MAX_LEN: usize = 64;

fn parse(accel: &str) -> Result<Shortcut, String> {
    if accel.is_empty() || accel.len() > MAX_LEN {
        return Err("Invalid shortcut".into());
    }
    let shortcut: Shortcut = accel
        .parse()
        .map_err(|e| format!("Invalid shortcut \"{accel}\": {e}"))?;
    // A bare key (e.g. "A") would swallow normal typing system-wide.
    let is_function_key = accel
        .rsplit('+')
        .next()
        .is_some_and(|k| k.len() >= 2 && k.starts_with('F') && k[1..].chars().all(|c| c.is_ascii_digit()));
    if shortcut.mods.is_empty() && !is_function_key {
        return Err("Shortcut needs a modifier (Ctrl, Alt, Shift or Win)".into());
    }
    Ok(shortcut)
}

/// Register the saved shortcut at startup. Failure is reported in Settings, not fatal.
pub fn register_initial(app: &AppHandle, accel: &str) {
    let state = tauri::Manager::state::<AppState>(app);
    let result = parse(accel).and_then(|sc| {
        app.global_shortcut()
            .register(sc)
            .map_err(|e| format!("{accel} is already in use by another app ({e})"))
    });
    *state.hotkey_error.lock().unwrap() = result.err();
}

/// Swap the shortcut atomically: if the new one can't be registered, the old one stays.
pub fn change(app: &AppHandle, state: &AppState, accel: &str) -> Result<String, String> {
    let new = parse(accel)?;
    let gs = app.global_shortcut();
    let mut current = state.hotkey.lock().unwrap();
    let old = parse(&current).ok();

    if let Some(old) = old {
        let _ = gs.unregister(old);
    }
    if let Err(e) = gs.register(new) {
        if let Some(old) = old {
            let _ = gs.register(old);
        }
        return Err(format!("{accel} is already in use by another app ({e})"));
    }

    *current = accel.to_string();
    *state.hotkey_error.lock().unwrap() = None;
    state
        .store
        .lock()
        .unwrap()
        .set_setting("hotkey", accel)
        .map_err(|e| e.to_string())?;
    Ok(accel.to_string())
}

pub fn suspend(app: &AppHandle, state: &AppState, suspended: bool) -> Result<(), String> {
    let current = parse(&state.hotkey.lock().unwrap())?;
    let gs = app.global_shortcut();
    if suspended {
        let _ = gs.unregister(current);
        Ok(())
    } else if gs.is_registered(current) {
        Ok(())
    } else {
        gs.register(current).map_err(|e| e.to_string())
    }
}
