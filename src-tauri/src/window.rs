//! Launcher window behaviour: show on the active monitor, hide on blur, toggle.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Theme, WebviewWindow, WindowEvent};

use crate::state::{self, AppState};

pub const EVT_SHOWN: &str = "fyn://shown";
pub const EVT_HIDDEN: &str = "fyn://hidden";
pub const EVT_OPEN_SETTINGS: &str = "fyn://open-settings";

/// Set while the colour picker's eyedropper is open, so picking a pixel elsewhere on
/// screen doesn't hide the launcher.
static AUTO_HIDE_SUSPENDED: AtomicBool = AtomicBool::new(false);

/// A manual start wants the window shown, but only once the UI has drawn its first
/// frame; showing it earlier flashes an empty panel and then pops the list in.
static SHOW_WHEN_READY: AtomicBool = AtomicBool::new(false);
/// If the UI never reports ready (e.g. it crashed), show anyway after this long.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Show the launcher as soon as the UI reports it has rendered (see [`ui_ready`]).
pub fn show_when_ready(app: &AppHandle) {
    SHOW_WHEN_READY.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_TIMEOUT);
        if SHOW_WHEN_READY.swap(false, Ordering::SeqCst) {
            show(&app);
        }
    });
}

/// Called by the UI once its first frame with data is drawn. Tells it what happens next:
/// `"showing"` (we show it now; the shown event plays the entrance), `"visible"` (already
/// on screen, e.g. after a dev reload, so the UI should play it itself) or `"hidden"`
/// (started at login; the entrance plays on the first open).
pub fn ui_ready(app: &AppHandle) -> &'static str {
    if SHOW_WHEN_READY.swap(false, Ordering::SeqCst) {
        show(app);
        return "showing";
    }
    match main_window(app).and_then(|w| w.is_visible().ok()) {
        Some(true) => "visible",
        _ => "hidden",
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn install(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if !AUTO_HIDE_SUSPENDED.load(Ordering::SeqCst) {
                hide(&handle);
            }
        }
    });
}

/// Fyn's own light/dark appearance ("system" follows Windows). Sets the native window
/// theme so the acrylic backdrop matches; the UI applies its colours from the setting too.
pub fn apply_theme(app: &AppHandle, theme: &str) {
    let Some(win) = main_window(app) else { return };
    let theme = match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    let _ = win.set_theme(theme);
}

pub fn suspend_auto_hide(suspended: bool) {
    AUTO_HIDE_SUSPENDED.store(suspended, Ordering::SeqCst);
}

pub fn show(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    // Never get stuck in "don't hide" if the UI forgot to switch it back.
    suspend_auto_hide(false);
    position_on_active_monitor(app, &win);
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    let _ = app.emit(EVT_SHOWN, ());

    if app.state::<AppState>().is_stale() {
        state::refresh(app);
    }
}

pub fn hide(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        let _ = app.emit(EVT_HIDDEN, ());
    }
}

pub fn toggle(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
        hide(app);
    } else {
        show(app);
    }
}

pub fn open_settings(app: &AppHandle) {
    show(app);
    let _ = app.emit(EVT_OPEN_SETTINGS, ());
}

/// Centre horizontally, slightly above centre vertically, on the monitor under the cursor.
fn position_on_active_monitor(app: &AppHandle, win: &WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else { return };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else { return };
    let Ok(size) = win.outer_size() else { return };

    let area = monitor.work_area();
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    // 40% of the free space above the window: just above centre, where the eye rests.
    let y = area.position.y + (area.size.height as i32 - size.height as i32) * 2 / 5;
    let _ = win.set_position(PhysicalPosition::new(x, y.max(area.position.y)));
}
