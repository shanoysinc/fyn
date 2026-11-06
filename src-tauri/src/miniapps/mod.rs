//! Mini apps: small built-in tools with their own screen (Clean Windows, …).

pub mod clean;
pub mod pomodoro;
pub mod ports;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use self::pomodoro::{Phase, PomodoroSettings, Timer};

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

// ---------- Port Killer ----------

#[tauri::command(async)]
pub fn ports_list(state: State<AppState>) -> Vec<ports::PortEntry> {
    let icons = crate::clipboard::icons_by_exe(&state.apps());
    ports::list(|exe| icons.get(exe).cloned())
}

/// Stop the process listening on `port`, if it's still `pid` and not part of Windows.
#[tauri::command(async)]
pub fn ports_kill(port: u16, pid: u32) -> Result<String, String> {
    ports::kill(port, pid)
}

// ---------- Password Generator / Dev Tools ----------

/// Copy a generated password without it entering any clipboard history (Fyn's or
/// Windows'), optionally clearing it from the clipboard after a minute.
#[tauri::command]
pub fn copy_secret(text: String, clear_after: bool) -> Result<(), String> {
    if text.is_empty() || text.len() > 1024 {
        return Err("Nothing to copy".into());
    }
    crate::clipboard::copy_private(&text, clear_after)
}

/// What's on the clipboard, to feed Dev Tools. Never reads a password manager's copy.
#[tauri::command(async)]
pub fn read_clipboard_text() -> Option<String> {
    crate::clipboard::read_text()
}

// ---------- Pomodoro ----------

pub const EVT_POMODORO: &str = "fyn://pomodoro";
const KEY_POMODORO: &str = "pomodoro_settings";
const MAX_LABEL_LEN: usize = 120;

pub struct PomoState {
    inner: Mutex<(Timer, PomodoroSettings)>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the UI shows: phase, countdown target and progress.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroView {
    phase: Phase,
    running: bool,
    /// When running: when the phase ends (unix ms), so the UI counts down by itself.
    ends_at: Option<i64>,
    remaining_ms: i64,
    duration_ms: i64,
    /// Started in this phase (running, or paused part-way): show it on the home screen.
    active: bool,
    done_in_cycle: u32,
    label: Option<String>,
    settings: PomodoroSettings,
}

fn view(timer: &Timer, settings: &PomodoroSettings) -> PomodoroView {
    let duration_ms = settings.duration_ms(timer.phase);
    PomodoroView {
        phase: timer.phase,
        running: timer.running(),
        ends_at: timer.ends_at,
        remaining_ms: timer.remaining_ms,
        duration_ms,
        active: timer.running() || timer.remaining_ms < duration_ms,
        done_in_cycle: timer.done_in_cycle,
        label: timer.label.clone(),
        settings: settings.clone(),
    }
}

fn load_pomodoro_settings(store: &Store) -> PomodoroSettings {
    store
        .get_setting(KEY_POMODORO)
        .and_then(|json| serde_json::from_str::<PomodoroSettings>(&json).ok())
        .and_then(|s| s.validated().ok())
        .unwrap_or_default()
}

/// Start the timer state and the ticker that finishes phases, notifies, and keeps the
/// tray tooltip counting down, whether or not Fyn's window is open.
pub fn init_pomodoro(app: &AppHandle) {
    let settings = load_pomodoro_settings(&app.state::<AppState>().store.lock().unwrap());
    app.manage(PomoState { inner: Mutex::new((Timer::new(&settings), settings)) });
    let app = app.clone();
    std::thread::Builder::new()
        .name("fyn-pomodoro".into())
        .spawn(move || {
            let mut last_tooltip = String::new();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let now = now_ms();
                let (finished, tooltip, snapshot) = {
                    let state = app.state::<PomoState>();
                    let mut guard = state.inner.lock().unwrap();
                    let (timer, settings) = &mut *guard;
                    let finished = timer.tick(now, settings).map(|f| (f, settings.clone()));
                    let v = view(timer, settings);
                    let tooltip = if v.active { pomodoro::tooltip(timer, now) } else { String::new() };
                    (finished, tooltip, v)
                };
                if let Some((f, settings)) = finished {
                    if let Some(session) = &f.session {
                        let _ = app.state::<AppState>().store.lock().unwrap().pomo_insert(session);
                    }
                    if settings.notify {
                        let (title, body) = pomodoro::notification(&f, &settings);
                        let _ = app.notification().builder().title(title).body(body).show();
                    }
                    let _ = app.emit(EVT_POMODORO, &snapshot);
                }
                if tooltip != last_tooltip {
                    let text = if tooltip.is_empty() { app.package_info().name.clone() } else { format!("Fyn · {tooltip}") };
                    if let Some(tray) = app.tray_by_id("main") {
                        let _ = tray.set_tooltip(Some(text));
                    }
                    last_tooltip = tooltip;
                }
            }
        })
        .expect("failed to start pomodoro timer");
}

/// Apply a change to the timer, store any finished session, tell the UI.
fn update(app: &AppHandle, change: impl FnOnce(&mut Timer, &PomodoroSettings, i64) -> Option<pomodoro::Session>) -> PomodoroView {
    let state = app.state::<PomoState>();
    let (session, v) = {
        let mut guard = state.inner.lock().unwrap();
        let (timer, settings) = &mut *guard;
        let session = change(timer, settings, now_ms());
        (session, view(timer, settings))
    };
    if let Some(session) = session {
        let _ = app.state::<AppState>().store.lock().unwrap().pomo_insert(&session);
    }
    let _ = app.emit(EVT_POMODORO, &v);
    v
}

#[tauri::command]
pub fn pomodoro_state(state: State<PomoState>) -> PomodoroView {
    let guard = state.inner.lock().unwrap();
    view(&guard.0, &guard.1)
}

/// Start (or resume). `label`: what you're working on (optional).
#[tauri::command]
pub fn pomodoro_start(app: AppHandle, label: Option<String>) -> Result<PomodoroView, String> {
    let label = label.map(|l| l.trim().to_string());
    if label.as_ref().is_some_and(|l| l.chars().count() > MAX_LABEL_LEN) {
        return Err("That label is too long".into());
    }
    Ok(update(&app, |t, _, now| {
        if let Some(l) = label {
            t.label = (!l.is_empty()).then_some(l);
        }
        t.start(now);
        None
    }))
}

#[tauri::command]
pub fn pomodoro_pause(app: AppHandle) -> PomodoroView {
    update(&app, |t, _, now| {
        t.pause(now);
        None
    })
}

/// End the current phase early and move to the next.
#[tauri::command]
pub fn pomodoro_skip(app: AppHandle) -> PomodoroView {
    update(&app, |t, s, now| t.skip(now, s).session)
}

/// Stop and start a fresh cycle.
#[tauri::command]
pub fn pomodoro_reset(app: AppHandle) -> PomodoroView {
    update(&app, |t, s, now| t.reset(now, s))
}

#[tauri::command]
pub fn set_pomodoro_settings(app: AppHandle, settings: PomodoroSettings) -> Result<PomodoroView, String> {
    let settings = settings.validated()?;
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    app.state::<AppState>().store.lock().unwrap().set_setting(KEY_POMODORO, &json).map_err(|e| e.to_string())?;
    let state = app.state::<PomoState>();
    let v = {
        let mut guard = state.inner.lock().unwrap();
        let (timer, current) = &mut *guard;
        // A phase that hasn't started yet takes the new length right away.
        if !timer.running() && timer.remaining_ms == current.duration_ms(timer.phase) {
            timer.remaining_ms = settings.duration_ms(timer.phase);
        }
        *current = settings;
        view(timer, current)
    };
    let _ = app.emit(EVT_POMODORO, &v);
    Ok(v)
}

/// Stats for the history screen. `tz_offset_min`: minutes east of UTC (local days).
#[tauri::command]
pub fn pomodoro_stats(state: State<AppState>, tz_offset_min: i32) -> Result<pomodoro::Stats, String> {
    if !(-14 * 60..=14 * 60).contains(&tz_offset_min) {
        return Err("Invalid time zone".into());
    }
    let sessions = state.store.lock().unwrap().pomo_all();
    Ok(pomodoro::stats(&sessions, now_ms() / 1000, tz_offset_min))
}

#[tauri::command]
pub fn pomodoro_clear_history(state: State<AppState>) -> Result<(), String> {
    state.store.lock().unwrap().pomo_clear().map_err(|e| e.to_string())
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
