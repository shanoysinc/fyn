//! IPC surface exposed to the UI.
//!
//! Security: the UI never passes file paths or command lines. It refers to apps only by
//! the opaque `id` produced by the indexer; anything that isn't in the current catalogue
//! is rejected. Inputs are length-limited before any work is done.

use std::collections::HashSet;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::indexer::{App, AppKind};
use crate::search::{self, frecency};
use crate::state::{self, AppState};
use crate::store::{now, Store};
use crate::system::{self, PathInfo, SystemCommand};
use crate::updater::{self, UpdateInfo};
use crate::{hotkey, launcher, window};

pub const SETTING_ONBOARDED: &str = "onboarded";
pub const SETTING_SEARCH_ENGINE: &str = "search_engine";
pub const SETTING_THEME: &str = "theme";
/// Set once launch-at-login has been switched on by default, so a later "off" sticks.
const SETTING_AUTOSTART_DEFAULTED: &str = "autostart_defaulted";
const SEARCH_ENGINES: [&str; 3] = ["google", "duckduckgo", "bing"];
const THEMES: [&str; 3] = ["system", "light", "dark"];
pub const SETTING_HOME_LAYOUT: &str = "home_layout";
const HOME_LAYOUTS: [&str; 2] = ["grid", "list"];

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
    onboarded: bool,
    search_engine: String,
    /// Fyn's own appearance: "system", "light" or "dark". Never changes the Windows theme.
    theme: String,
    /// Favorites and Suggestions as a row of icons ("grid") or a "list".
    home_layout: String,
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
    let (onboarded, search_engine, theme, home_layout) = {
        let store = state.store.lock().unwrap();
        (
            store.get_setting(SETTING_ONBOARDED).as_deref() == Some("1"),
            saved_search_engine(&store),
            saved_theme(&store),
            saved_home_layout(&store),
        )
    };
    Settings {
        hotkey: state.hotkey.lock().unwrap().clone(),
        hotkey_error: state.hotkey_error.lock().unwrap().clone(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        app_count: state.apps().len(),
        version: app.package_info().version.to_string(),
        onboarded,
        search_engine,
        theme,
        home_layout,
    }
}

/// How Favorites and Suggestions are shown on the home screen ("grid" if unset or unknown).
fn saved_home_layout(store: &Store) -> String {
    store
        .get_setting(SETTING_HOME_LAYOUT)
        .filter(|l| HOME_LAYOUTS.contains(&l.as_str()))
        .unwrap_or_else(|| HOME_LAYOUTS[0].to_string())
}

/// "grid" (a row of icons) or "list".
#[tauri::command]
pub fn set_home_layout(state: State<AppState>, layout: String) -> Result<(), String> {
    if !HOME_LAYOUTS.contains(&layout.as_str()) {
        return Err("Unknown layout".into());
    }
    state
        .store
        .lock()
        .unwrap()
        .set_setting(SETTING_HOME_LAYOUT, &layout)
        .map_err(|e| e.to_string())
}

/// The saved web search engine ("google" if unset or unknown).
fn saved_search_engine(store: &Store) -> String {
    store
        .get_setting(SETTING_SEARCH_ENGINE)
        .filter(|e| SEARCH_ENGINES.contains(&e.as_str()))
        .unwrap_or_else(|| SEARCH_ENGINES[0].to_string())
}

/// Fyn's saved appearance ("system" if unset or unknown).
pub fn saved_theme(store: &Store) -> String {
    store
        .get_setting(SETTING_THEME)
        .filter(|t| THEMES.contains(&t.as_str()))
        .unwrap_or_else(|| THEMES[0].to_string())
}

/// Change Fyn's own light/dark appearance. Only affects Fyn's window.
#[tauri::command]
pub fn set_theme(app: AppHandle, state: State<AppState>, theme: String) -> Result<(), String> {
    if !THEMES.contains(&theme.as_str()) {
        return Err("Unknown theme".into());
    }
    state
        .store
        .lock()
        .unwrap()
        .set_setting(SETTING_THEME, &theme)
        .map_err(|e| e.to_string())?;
    window::apply_theme(&app, &theme);
    Ok(())
}

#[tauri::command]
pub fn set_onboarded(state: State<AppState>, done: bool) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .set_setting(SETTING_ONBOARDED, if done { "1" } else { "0" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_search_engine(state: State<AppState>, engine: String) -> Result<(), String> {
    if !SEARCH_ENGINES.contains(&engine.as_str()) {
        return Err("Unknown search engine".into());
    }
    state
        .store
        .lock()
        .unwrap()
        .set_setting(SETTING_SEARCH_ENGINE, &engine)
        .map_err(|e| e.to_string())
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

/// Launch at login is on by default: switch it on once, the first time an installed
/// (release) build runs. After that the user's choice in Settings is never overridden.
/// Dev builds skip this so `target\debug\fyn.exe` never gets registered to start at login.
pub fn enable_autostart_by_default(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    if !should_default_autostart(&store) {
        return;
    }
    match app.autolaunch().enable() {
        Ok(()) => {
            if let Err(e) = store.set_setting(SETTING_AUTOSTART_DEFAULTED, "1") {
                eprintln!("[fyn] failed to save autostart default: {e}");
            }
        }
        // Not recorded, so it's tried again on the next start.
        Err(e) => eprintln!("[fyn] couldn't enable launch at login: {e}"),
    }
}

/// True until the launch-at-login default has been applied once.
fn should_default_autostart(store: &Store) -> bool {
    store.get_setting(SETTING_AUTOSTART_DEFAULTED).is_none()
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

// ---------- built-in commands ----------

/// Runs off the main thread: some commands (theme broadcast, Recycle Bin) can take a moment.
#[tauri::command(async)]
pub fn run_system_command(app: AppHandle, command: String) -> Result<Option<String>, String> {
    let cmd = SystemCommand::parse(&command).ok_or("Unknown command")?;
    if cmd.hides_window() {
        window::hide(&app);
    }
    system::run(cmd)
}

#[tauri::command]
pub fn open_settings_page(app: AppHandle, uri: String) -> Result<(), String> {
    system::open_settings_page(&uri)?;
    window::hide(&app);
    Ok(())
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    system::open_url(&url)?;
    window::hide(&app);
    Ok(())
}

/// Async because checking a network path can block for a while.
#[tauri::command(async)]
pub fn check_path(path: String) -> Option<PathInfo> {
    system::check_path(&path)
}

#[tauri::command(async)]
pub fn open_path(app: AppHandle, path: String, reveal: bool) -> Result<(), String> {
    system::open_path(&path, reveal)?;
    window::hide(&app);
    Ok(())
}

#[tauri::command]
pub fn suspend_auto_hide(suspended: bool) {
    window::suspend_auto_hide(suspended);
}

/// The UI has rendered its first frame with data; show the window if startup asked to.
#[tauri::command]
pub fn ui_ready(app: AppHandle) -> &'static str {
    window::ui_ready(&app)
}

// ---------- updates ----------

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    updater::check(&app).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn store() -> Store {
        Store::open(Path::new(":memory:")).unwrap()
    }

    #[test]
    fn home_layout_defaults_to_grid_and_ignores_unknown_values() {
        let s = store();
        assert_eq!(saved_home_layout(&s), "grid");
        s.set_setting(SETTING_HOME_LAYOUT, "list").unwrap();
        assert_eq!(saved_home_layout(&s), "list");
        s.set_setting(SETTING_HOME_LAYOUT, "carousel").unwrap();
        assert_eq!(saved_home_layout(&s), "grid");
    }

    #[test]
    fn autostart_is_defaulted_only_once() {
        let s = store();
        assert!(should_default_autostart(&s), "fresh install: turn it on");
        s.set_setting(SETTING_AUTOSTART_DEFAULTED, "1").unwrap();
        assert!(!should_default_autostart(&s), "afterwards the user's choice wins");
    }

    #[test]
    fn check_id_enforces_bounds() {
        assert!(check_id("").is_err());
        assert!(check_id(r"lnk:c:\a.lnk").is_ok());
        assert!(check_id(&"x".repeat(MAX_ID_LEN)).is_ok());
        assert!(check_id(&"x".repeat(MAX_ID_LEN + 1)).is_err());
    }

    #[test]
    fn theme_defaults_to_system_and_ignores_unknown_values() {
        let s = store();
        assert_eq!(saved_theme(&s), "system");
        s.set_setting(SETTING_THEME, "dark").unwrap();
        assert_eq!(saved_theme(&s), "dark");
        s.set_setting(SETTING_THEME, "purple").unwrap();
        assert_eq!(saved_theme(&s), "system");
    }

    #[test]
    fn search_engine_defaults_to_google_and_ignores_unknown_values() {
        let s = store();
        assert_eq!(saved_search_engine(&s), "google");
        s.set_setting(SETTING_SEARCH_ENGINE, "duckduckgo").unwrap();
        assert_eq!(saved_search_engine(&s), "duckduckgo");
        s.set_setting(SETTING_SEARCH_ENGINE, "altavista").unwrap();
        assert_eq!(saved_search_engine(&s), "google");
    }

    #[test]
    fn allowlists_match_the_ui() {
        // Keep in sync with SearchEngine / Theme / HomeLayout in src/lib/ipc.ts.
        assert_eq!(SEARCH_ENGINES, ["google", "duckduckgo", "bing"]);
        assert_eq!(THEMES, ["system", "light", "dark"]);
        assert_eq!(HOME_LAYOUTS, ["grid", "list"]); // HomeLayout in src/lib/ipc.ts
    }
}
