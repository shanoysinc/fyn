//! Global, user-configurable activation shortcut.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};

use crate::state::AppState;

/// Dev builds default to a different shortcut so "Fyn Dev" and an installed Fyn can run
/// side by side without fighting over Alt+Space.
#[cfg(not(debug_assertions))]
pub const DEFAULT: &str = "Alt+Space";
#[cfg(debug_assertions)]
pub const DEFAULT: &str = "Alt+Shift+Space";
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
    // Shift on its own isn't enough either: Shift+A is just typing a capital A.
    let typing_mods = shortcut.mods.is_empty() || shortcut.mods == Modifiers::SHIFT;
    if typing_mods && !is_function_key {
        return Err("Shortcut needs Ctrl, Alt or Win (Shift alone isn't enough)".into());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_shortcuts_with_a_real_modifier() {
        assert!(parse(DEFAULT).is_ok());
        assert!(parse("Ctrl+Shift+KeyK").is_ok());
        assert!(parse("Alt+Space").is_ok());
        assert!(parse("Super+KeyF").is_ok());
    }

    #[test]
    fn function_keys_need_no_modifier() {
        assert!(parse("F1").is_ok());
        assert!(parse("F12").is_ok());
        assert!(parse("Shift+F5").is_ok());
    }

    #[test]
    fn rejects_shortcuts_that_would_swallow_typing() {
        assert!(parse("KeyA").is_err());
        assert!(parse("Space").is_err());
        assert!(parse("Shift+KeyA").is_err());
        assert!(parse("Shift+Digit1").is_err());
    }

    #[test]
    fn rejects_empty_garbage_and_overlong_input() {
        assert!(parse("").is_err());
        assert!(parse("Ctrl+NotAKey").is_err());
        assert!(parse("Ctrl+").is_err());
        let long = format!("Ctrl+{}", "Shift+".repeat(20)) + "KeyA";
        assert!(long.len() > MAX_LEN);
        assert!(parse(&long).is_err());
    }
}
