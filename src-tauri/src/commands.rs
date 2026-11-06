//! IPC surface exposed to the UI.
//!
//! Security: the UI never passes file paths or command lines. It refers to apps only by
//! the opaque `id` produced by the indexer; anything that isn't in the current catalogue
//! is rejected. Inputs are length-limited before any work is done.

use std::collections::HashSet;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::indexer::{App, AppKind};
use crate::search::{self, frecency};
use crate::state::{self, AppState};
use crate::store::now;
use crate::{hotkey, launcher, window};

const MAX_QUERY_LEN: usize = 256;
const MAX_ID_LEN: usize = 2048;
const SEARCH_LIMIT: usize = 50;
const SUGGESTION_COUNT: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    name: String,
    kind: AppKind,
    icon: Option<String>,
    path: String,
    pinned: bool,
    can_run_as_admin: bool,
    matches: Vec<u32>,
}

impl Item {
    fn new(app: &App, pinned: bool, matches: Vec<u32>) -> Self {
        Self {
            id: app.id.clone(),
            name: app.name.clone(),
            kind: app.kind,
            icon: app.icon.clone(),
            path: app.display_path().to_string(),
            pinned,
            can_run_as_admin: app.kind == AppKind::Desktop,
            matches,
        }
    }
}

#[derive(Serialize)]
pub struct Home {
    favorites: Vec<Item>,
    suggestions: Vec<Item>,
    applications: Vec<Item>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    hotkey: String,
    hotkey_error: Option<String>,
    autostart: bool,
    app_count: usize,
    version: String,
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err("Invalid app id".into());
    }
    Ok(())
}

fn find(state: &AppState, id: &str) -> Result<App, String> {
    check_id(id)?;
    state
        .apps()
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| "That app is no longer installed".to_string())
}

#[tauri::command]
pub fn get_home(state: State<AppState>) -> Home {
    let apps = state.apps();
    let (pins, usage) = {
        let store = state.store.lock().unwrap();
        (store.pins(), store.usage())
    };
    let pinned: HashSet<&str> = pins.iter().map(String::as_str).collect();

    let favorites = pins
        .iter()
        .filter_map(|id| apps.iter().find(|a| &a.id == id))
        .map(|a| Item::new(a, true, Vec::new()))
        .collect();

    let t = now();
    let mut ranked: Vec<(&App, f64)> = apps
        .iter()
        .filter(|a| !pinned.contains(a.id.as_str()))
        .filter_map(|a| usage.get(&a.id).map(|u| (a, frecency(u, t))))
        .filter(|(_, f)| *f > 0.0)
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let suggestions = ranked
        .into_iter()
        .take(SUGGESTION_COUNT)
        .map(|(a, _)| Item::new(a, false, Vec::new()))
        .collect();

    let applications = apps
        .iter()
        .map(|a| Item::new(a, pinned.contains(a.id.as_str()), Vec::new()))
        .collect();

    Home { favorites, suggestions, applications }
}

#[tauri::command]
pub fn search(state: State<AppState>, query: String) -> Result<Vec<Item>, String> {
    if query.len() > MAX_QUERY_LEN {
        return Err("Query too long".into());
    }
    let apps = state.apps();
    let (pins, usage) = {
        let store = state.store.lock().unwrap();
        (store.pins().into_iter().collect::<HashSet<_>>(), store.usage())
    };
    let hits = {
        let mut matcher = state.matcher.lock().unwrap();
        search::search(&apps, &query, &mut matcher, &usage, &pins, now(), SEARCH_LIMIT)
    };
    Ok(hits
        .into_iter()
        .map(|h| {
            let app = &apps[h.index];
            Item::new(app, pins.contains(&app.id), h.matches)
        })
        .collect())
}

#[tauri::command]
pub fn launch(app: AppHandle, state: State<AppState>, id: String, admin: bool) -> Result<(), String> {
    let target = find(&state, &id)?;
    launcher::launch(&target, admin)?;
    window::hide(&app);
    if let Err(e) = state.store.lock().unwrap().record_launch(&target.id) {
        eprintln!("[fyn] failed to record launch: {e}");
    }
    Ok(())
}

#[tauri::command]
pub fn reveal(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let target = find(&state, &id)?;
    launcher::reveal(&target)?;
    window::hide(&app);
    Ok(())
}

#[tauri::command]
pub fn toggle_pin(state: State<AppState>, id: String) -> Result<bool, String> {
    let target = find(&state, &id)?;
    state
        .store
        .lock()
        .unwrap()
        .toggle_pin(&target.id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_pin(state: State<AppState>, id: String, delta: i32) -> Result<(), String> {
    check_id(&id)?;
    state
        .store
        .lock()
        .unwrap()
        .move_pin(&id, delta.signum())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    window::hide(&app);
}

#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<AppState>) -> Settings {
    Settings {
        hotkey: state.hotkey.lock().unwrap().clone(),
        hotkey_error: state.hotkey_error.lock().unwrap().clone(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        app_count: state.apps().len(),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
pub fn set_hotkey(app: AppHandle, state: State<AppState>, hotkey: String) -> Result<String, String> {
    hotkey::change(&app, &state, &hotkey)
}

/// Temporarily release the global shortcut while the user records a new one.
#[tauri::command]
pub fn suspend_hotkey(app: AppHandle, state: State<AppState>, suspended: bool) -> Result<(), String> {
    hotkey::suspend(&app, &state, suspended)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rescan(app: AppHandle) {
    state::refresh(&app);
}
