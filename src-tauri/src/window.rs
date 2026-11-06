//! Launcher window behaviour: show on the active monitor, hide on blur, toggle.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

use crate::state::{self, AppState};

pub const EVT_SHOWN: &str = "fyn://shown";
pub const EVT_HIDDEN: &str = "fyn://hidden";
pub const EVT_OPEN_SETTINGS: &str = "fyn://open-settings";

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn install(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide(&handle);
        }
    });
}

pub fn show(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
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

/// Centre horizontally, upper third vertically, on the monitor under the cursor.
fn position_on_active_monitor(app: &AppHandle, win: &WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else { return };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else { return };
    let Ok(size) = win.outer_size() else { return };

    let area = monitor.work_area();
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + (area.size.height as i32 - size.height as i32) / 4;
    let _ = win.set_position(PhysicalPosition::new(x, y.max(area.position.y)));
}
