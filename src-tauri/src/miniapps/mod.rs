//! Mini apps: small built-in tools with their own screen (Clean Windows, …).

pub mod clean;

use tauri::State;

use self::clean::{CleanReport, CleanSettings, Roots, ScanReport};
use crate::state::AppState;
use crate::store::Store;

const KEY_CLEAN_ENABLED: &str = "clean_enabled";
const KEY_CLEAN_PROTECTED: &str = "clean_protected";
const MAX_IDS: usize = 200;
const MAX_ID_LEN: usize = 300;

fn load_clean_settings(store: &Store) -> CleanSettings {
    let d = CleanSettings::default();
    let list = |v: String, sep: char| v.split(sep).filter(|s| !s.is_empty()).map(str::to_string).collect();
    CleanSettings {
        // Saved as "" when everything is switched off, so "missing" means defaults.
        enabled: store.get_setting(KEY_CLEAN_ENABLED).map(|v| list(v, ',')).unwrap_or(d.enabled),
        protected: store.get_setting(KEY_CLEAN_PROTECTED).map(|v| list(v, '\n')).unwrap_or(d.protected),
    }
}

#[tauri::command]
pub fn clean_settings(state: State<AppState>) -> CleanSettings {
    load_clean_settings(&state.store.lock().unwrap())
}

#[tauri::command]
pub fn set_clean_settings(state: State<AppState>, settings: CleanSettings) -> Result<CleanSettings, String> {
    let settings = settings.validated()?;
    let store = state.store.lock().unwrap();
    store.set_setting(KEY_CLEAN_ENABLED, &settings.enabled.join(",")).map_err(|e| e.to_string())?;
    store.set_setting(KEY_CLEAN_PROTECTED, &settings.protected.join("\n")).map_err(|e| e.to_string())?;
    Ok(settings)
}

/// Read-only scan of what can be freed. Runs off the main thread (big caches take a moment).
#[tauri::command(async)]
pub fn clean_scan(state: State<AppState>) -> ScanReport {
    let settings = load_clean_settings(&state.store.lock().unwrap());
    clean::scan(&Roots::from_env(), &settings)
}

/// Delete the chosen categories / emulators / images. Paths are re-derived in Rust; the
/// UI only names what to clean. Protected names are re-checked here.
#[tauri::command(async)]
pub fn clean_run(state: State<AppState>, categories: Vec<String>, items: Vec<String>) -> Result<CleanReport, String> {
    if categories.len() > MAX_IDS || items.len() > MAX_IDS || items.iter().chain(&categories).any(|i| i.len() > MAX_ID_LEN) {
        return Err("Too many items".into());
    }
    let settings = load_clean_settings(&state.store.lock().unwrap());
    Ok(clean::clean(&Roots::from_env(), &settings, &categories, &items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn clean_settings_persist_including_all_off() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        assert_eq!(load_clean_settings(&store), CleanSettings::default());
        store.set_setting(KEY_CLEAN_ENABLED, "").unwrap();
        store.set_setting(KEY_CLEAN_PROTECTED, "beacon\nemr\nclinic").unwrap();
        let s = load_clean_settings(&store);
        assert!(s.enabled.is_empty(), "everything switched off stays off");
        assert_eq!(s.protected, vec!["beacon", "emr", "clinic"]);
    }
}
