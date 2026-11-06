//! Shared application state and the background re-indexing pipeline.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use nucleo_matcher::Matcher;
use tauri::{AppHandle, Emitter, Manager};

use crate::indexer::{self, App};
use crate::{icons, search, store::Store};

pub const EVT_APPS_CHANGED: &str = "fyn://apps-changed";
/// Re-index on open if the catalogue is older than this (safety net for missed watcher events).
const STALE_AFTER: Duration = Duration::from_secs(10 * 60);

pub struct AppState {
    pub data_dir: PathBuf,
    pub apps: RwLock<Arc<Vec<App>>>,
    pub store: Mutex<Store>,
    pub matcher: Mutex<Matcher>,
    pub hotkey: Mutex<String>,
    pub hotkey_error: Mutex<Option<String>>,
    scanning: AtomicBool,
    rescan_requested: AtomicBool,
    last_scan: Mutex<Option<Instant>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, store: Store, cached: Vec<App>, hotkey: String) -> Self {
        Self {
            data_dir,
            apps: RwLock::new(Arc::new(cached)),
            store: Mutex::new(store),
            matcher: Mutex::new(search::new_matcher()),
            hotkey: Mutex::new(hotkey),
            hotkey_error: Mutex::new(None),
            scanning: AtomicBool::new(false),
            rescan_requested: AtomicBool::new(false),
            last_scan: Mutex::new(None),
        }
    }

    pub fn icons_dir(&self) -> PathBuf {
        self.data_dir.join("icons")
    }

    pub fn apps(&self) -> Arc<Vec<App>> {
        self.apps.read().unwrap().clone()
    }

    fn set_apps(&self, apps: Vec<App>) {
        *self.apps.write().unwrap() = Arc::new(apps);
    }

    pub fn is_stale(&self) -> bool {
        self.last_scan
            .lock()
            .unwrap()
            .map_or(true, |t| t.elapsed() > STALE_AFTER)
    }
}

/// Re-index in the background. Coalesces concurrent requests into at most one extra pass.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.scanning.swap(true, Ordering::SeqCst) {
        state.rescan_requested.store(true, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("fyn-indexer".into())
        .spawn(move || {
            let state = app.state::<AppState>();
            loop {
                let started = Instant::now();
                let icons_dir = state.icons_dir();
                let mut apps = indexer::scan();
                icons::attach_cached(&icons_dir, &mut apps);

                // Publish names first so new apps are searchable immediately…
                state.set_apps(apps.clone());
                let _ = app.emit(EVT_APPS_CHANGED, ());

                // …then fill in any icons we haven't seen before.
                if icons::extract_missing(&icons_dir, &mut apps) > 0 {
                    state.set_apps(apps.clone());
                    let _ = app.emit(EVT_APPS_CHANGED, ());
                }
                indexer::cache::save(&state.data_dir, &apps);
                *state.last_scan.lock().unwrap() = Some(Instant::now());

                #[cfg(debug_assertions)]
                eprintln!("[fyn] indexed {} apps in {:?}", apps.len(), started.elapsed());
                let _ = started;

                if !state.rescan_requested.swap(false, Ordering::SeqCst) {
                    break;
                }
            }
            state.scanning.store(false, Ordering::SeqCst);
        })
        .expect("failed to spawn indexer thread");
}
