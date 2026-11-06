//! Watches the Start Menu folders and re-indexes when apps are installed or removed.

use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tauri::AppHandle;

use crate::indexer::shortcuts::start_menu_dirs;
use crate::state;

/// Installers tend to create many files in a burst; wait for things to settle.
const DEBOUNCE: Duration = Duration::from_millis(1500);

pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("fyn-watcher".into())
        .spawn(move || {
            let (tx, rx) = mpsc::channel();
            let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if res.is_ok() {
                    let _ = tx.send(());
                }
            }) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[fyn] file watcher unavailable: {e}");
                    return;
                }
            };
            for dir in start_menu_dirs() {
                if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
                    eprintln!("[fyn] can't watch {}: {e}", dir.display());
                }
            }
            while rx.recv().is_ok() {
                while rx.recv_timeout(DEBOUNCE).is_ok() {}
                state::refresh(&app);
            }
        });
}
