//! Clipboard history: watches copies, keeps them encrypted, and pastes them back.
//!
//! Privacy, in layers (see README "Clipboard history"):
//! 1. Copies flagged "don't record" by the copying app (password managers) are skipped.
//! 2. Copies made in ignored apps are skipped.
//! 3. Known secret formats, card numbers and anything that looks like a password are
//!    never kept: not on disk, not in memory ([`classify`]). Optionally, a password-like
//!    copy is also cleared from the clipboard after a minute.
//! 4. Everything else is stored DPAPI-encrypted, pruned by age and count.
//!
//! Off until the user turns it on; turning it off deletes everything.

pub mod classify;
pub mod crypto;
mod win;

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::AddClipboardFormatListener;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, HWND_MESSAGE, MSG,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WNDCLASSW,
};
use zeroize::Zeroizing;

use self::classify::Class;
use crate::state::AppState;
use crate::store::{now, Store};
use crate::window;

pub const EVT_CHANGED: &str = "fyn://clipboard-changed";

/// How long a password-like copy may stay on the clipboard (if that option is on).
const CLEAR_AFTER: Duration = Duration::from_secs(60);
const MAX_ITEMS: usize = 200;
/// Longest text sent to the UI for one item (the full text is still pasted).
const MAX_UI_CHARS: usize = 20_000;
/// Wait for the previous app to get focus back before pressing Ctrl+V in it.
const PASTE_DELAY: Duration = Duration::from_millis(150);

const KEY_ENABLED: &str = "clipboard_enabled";
const KEY_RETENTION: &str = "clipboard_retention_days";
const KEY_CLEAR: &str = "clipboard_clear_sensitive";
const KEY_IGNORED: &str = "clipboard_ignored_apps";

const RETENTIONS: [u32; 3] = [1, 7, 30];
const MAX_IGNORED: usize = 50;

/// Password managers: nothing copied while one of these is in front is ever recorded.
pub const DEFAULT_IGNORED: [&str; 11] = [
    "1password.exe",
    "bitwarden.exe",
    "dashlane.exe",
    "enpass.exe",
    "keepass.exe",
    "keepassxc.exe",
    "keeperpasswordmanager.exe",
    "lastpass.exe",
    "nordpass.exe",
    "protonpass.exe",
    "roboform.exe",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSettings {
    pub enabled: bool,
    pub retention_days: u32,
    /// Clear the system clipboard a minute after a password-like copy (unless something
    /// else was copied since). The password itself is never stored either way.
    pub clear_sensitive: bool,
    pub ignored_apps: Vec<String>,
}

impl Default for ClipSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: 7,
            clear_sensitive: true,
            ignored_apps: DEFAULT_IGNORED.iter().map(|s| s.to_string()).collect(),
        }
    }
}

impl ClipSettings {
    fn load(store: &Store) -> Self {
        let d = Self::default();
        Self {
            enabled: store.get_setting(KEY_ENABLED).as_deref() == Some("1"),
            retention_days: store
                .get_setting(KEY_RETENTION)
                .and_then(|v| v.parse().ok())
                .filter(|v| RETENTIONS.contains(v))
                .unwrap_or(d.retention_days),
            clear_sensitive: store.get_setting(KEY_CLEAR).map_or(d.clear_sensitive, |v| v == "1"),
            ignored_apps: store
                .get_setting(KEY_IGNORED)
                .map(|v| v.lines().filter(|l| !l.is_empty()).map(str::to_string).collect())
                .unwrap_or(d.ignored_apps),
        }
    }

    fn save(&self, store: &Store) -> rusqlite::Result<()> {
        store.set_setting(KEY_ENABLED, if self.enabled { "1" } else { "0" })?;
        store.set_setting(KEY_RETENTION, &self.retention_days.to_string())?;
        store.set_setting(KEY_CLEAR, if self.clear_sensitive { "1" } else { "0" })?;
        store.set_setting(KEY_IGNORED, &self.ignored_apps.join("\n"))
    }

    /// Check and normalise settings from the UI.
    fn validated(mut self) -> Result<Self, String> {
        if !RETENTIONS.contains(&self.retention_days) {
            return Err("Unknown retention period".into());
        }
        let mut apps = Vec::new();
        for app in &self.ignored_apps {
            let app = app.trim().to_lowercase();
            if app.is_empty() {
                continue;
            }
            let valid = app.len() <= 64
                && app.ends_with(".exe")
                && app.chars().all(|c| c.is_alphanumeric() || " ._-()".contains(c));
            if !valid {
                return Err(format!("\"{app}\" isn't an app file name like keepassxc.exe"));
            }
            if !apps.contains(&app) {
                apps.push(app);
            }
        }
        if apps.len() > MAX_IGNORED {
            return Err("Too many ignored apps".into());
        }
        self.ignored_apps = apps;
        Ok(self)
    }
}

struct Item {
    id: i64,
    text: Zeroizing<String>,
    source: Option<String>,
    created: i64,
}

struct Inner {
    settings: ClipSettings,
    /// Newest first.
    items: Vec<Item>,
    /// `Some(None)` = paused until resumed.
    paused: Option<Option<Instant>>,
}

impl Inner {
    fn is_paused(&mut self) -> bool {
        match self.paused {
            Some(Some(until)) if Instant::now() >= until => {
                self.paused = None;
                false
            }
            Some(_) => true,
            None => false,
        }
    }
}

pub struct ClipState {
    inner: Mutex<Inner>,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static MONITOR_HWND: AtomicIsize = AtomicIsize::new(0);

/// Load settings and (if enabled) the saved history, then start watching the clipboard.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    let settings = ClipSettings::load(&store);
    let items = if settings.enabled { load_items(&store) } else { Vec::new() };
    drop(store);

    app.manage(ClipState { inner: Mutex::new(Inner { settings, items, paused: None }) });
    let _ = APP.set(app.clone());
    std::thread::Builder::new()
        .name("fyn-clipboard".into())
        .spawn(run_monitor)
        .expect("failed to start clipboard monitor");
}

/// Decrypt the saved history. Rows that can't be decrypted (e.g. another Windows user's)
/// are deleted.
fn load_items(store: &Store) -> Vec<Item> {
    let mut items = Vec::new();
    for (id, created, source, data) in store.clip_all() {
        match crypto::unprotect(&data) {
            Ok(text) => items.push(Item { id, text, source, created }),
            Err(_) => {
                let _ = store.clip_delete(id);
            }
        }
    }
    items
}

fn run_monitor() {
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        let class = w!("FynClipboardMonitor");
        let wc = WNDCLASSW { lpfnWndProc: Some(monitor_proc), hInstance: module.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        // A message-only window: invisible, just receives clipboard notifications.
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(module.into()),
            None,
        ) else {
            eprintln!("[fyn] couldn't create the clipboard monitor window");
            return;
        };
        MONITOR_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
        if let Err(e) = AddClipboardFormatListener(hwnd) {
            eprintln!("[fyn] couldn't watch the clipboard: {e}");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn monitor_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_CLIPBOARDUPDATE {
        if let Some(app) = APP.get() {
            on_clipboard_change(app, hwnd);
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn on_clipboard_change(app: &AppHandle, hwnd: HWND) {
    let seq = win::sequence();
    if win::is_own_change(seq) {
        return; // Fyn pasting an item back
    }
    let clip = app.state::<ClipState>();
    let settings = {
        let mut inner = clip.inner.lock().unwrap();
        if !inner.settings.enabled || inner.is_paused() {
            return;
        }
        inner.settings.clone()
    };

    let source = win::foreground_app();
    if source.as_ref().is_some_and(|s| settings.ignored_apps.contains(s)) {
        return;
    }
    // `text` is wiped when it goes out of scope, whichever branch runs.
    let text = match win::read(hwnd) {
        Ok(win::Read::Text(text)) => text,
        _ => return, // excluded by the copying app, not text, or the clipboard was busy
    };

    match classify::classify(&text) {
        Class::Normal => {
            if add_item(app, &text, source, &settings).is_ok() {
                let _ = app.emit(EVT_CHANGED, ());
            }
        }
        // Looks like a password: never kept, anywhere. Optionally take it off the
        // clipboard too, a minute from now, if nothing else has been copied by then.
        Class::Sensitive => {
            if settings.clear_sensitive {
                clear_later(seq);
            }
        }
        Class::Never(_) => {}
    }
}

/// Empty the clipboard after [`CLEAR_AFTER`] if it still holds the copy made at `seq`.
/// Only the clipboard's change counter is remembered, never its contents.
fn clear_later(seq: u32) {
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR_AFTER);
        win::clear_if_unchanged(seq);
    });
}

/// Save an item (encrypted), moving an identical older one to the top.
fn add_item(app: &AppHandle, text: &str, source: Option<String>, settings: &ClipSettings) -> Result<(), String> {
    let clip = app.state::<ClipState>();
    let state = app.state::<AppState>();
    let mut inner = clip.inner.lock().unwrap();
    let store = state.store.lock().unwrap();

    let created = now();
    let data = crypto::protect(text)?;
    for old in inner.items.iter().filter(|i| *i.text == text) {
        let _ = store.clip_delete(old.id);
    }
    inner.items.retain(|i| *i.text != text);
    let id = store.clip_insert(created, source.as_deref(), &data).map_err(|e| e.to_string())?;
    inner.items.insert(0, Item { id, text: Zeroizing::new(text.to_string()), source, created });

    let cutoff = created - i64::from(settings.retention_days) * 86_400;
    let _ = store.clip_prune(cutoff, MAX_ITEMS);
    inner.items.retain(|i| i.created >= cutoff);
    inner.items.truncate(MAX_ITEMS);
    Ok(())
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    id: i64,
    text: String,
    truncated: bool,
    chars: usize,
    source: Option<String>,
    created: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipStatus {
    #[serde(flatten)]
    settings: ClipSettings,
    paused: bool,
    /// Unix seconds when a timed pause ends.
    paused_until: Option<i64>,
}

fn status(inner: &mut Inner) -> ClipStatus {
    let paused = inner.is_paused();
    let paused_until = match inner.paused {
        Some(Some(until)) => Some(now() + until.saturating_duration_since(Instant::now()).as_secs() as i64),
        _ => None,
    };
    ClipStatus { settings: inner.settings.clone(), paused, paused_until }
}

#[tauri::command]
pub fn clipboard_status(clip: State<ClipState>) -> ClipStatus {
    status(&mut clip.inner.lock().unwrap())
}

/// Change settings. Turning history off deletes everything it kept.
#[tauri::command]
pub fn set_clipboard_settings(
    app: AppHandle,
    clip: State<ClipState>,
    state: State<AppState>,
    settings: ClipSettings,
) -> Result<ClipStatus, String> {
    let settings = settings.validated()?;
    let mut inner = clip.inner.lock().unwrap();
    let store = state.store.lock().unwrap();
    settings.save(&store).map_err(|e| e.to_string())?;
    if !settings.enabled {
        inner.items.clear();
        inner.paused = None;
        store.clip_delete_all().map_err(|e| e.to_string())?;
    } else if settings.retention_days < inner.settings.retention_days {
        let cutoff = now() - i64::from(settings.retention_days) * 86_400;
        let _ = store.clip_prune(cutoff, MAX_ITEMS);
        inner.items.retain(|i| i.created >= cutoff);
    }
    inner.settings = settings;
    let result = status(&mut inner);
    drop((inner, store));
    let _ = app.emit(EVT_CHANGED, ());
    Ok(result)
}

#[tauri::command]
pub fn clipboard_list(clip: State<ClipState>) -> Vec<ClipEntry> {
    let inner = clip.inner.lock().unwrap();
    inner
        .items
        .iter()
        .map(|i| {
            let chars = i.text.chars().count();
            ClipEntry {
                id: i.id,
                text: i.text.chars().take(MAX_UI_CHARS).collect(),
                truncated: chars > MAX_UI_CHARS,
                chars,
                source: i.source.clone(),
                created: i.created,
            }
        })
        .collect()
}

/// Copy an item back onto the clipboard (and to the top of the history).
#[tauri::command]
pub fn clipboard_copy(app: AppHandle, id: i64) -> Result<(), String> {
    put_back(&app, id)
}

/// Paste an item into the app that was in front before Fyn opened.
#[tauri::command(async)]
pub fn clipboard_paste(app: AppHandle, id: i64) -> Result<(), String> {
    put_back(&app, id)?;
    window::hide(&app);
    std::thread::sleep(PASTE_DELAY);
    win::send_paste();
    Ok(())
}

fn put_back(app: &AppHandle, id: i64) -> Result<(), String> {
    let clip = app.state::<ClipState>();
    let (text, source, settings) = {
        let inner = clip.inner.lock().unwrap();
        let item = inner.items.iter().find(|i| i.id == id).ok_or("That item is no longer in the history")?;
        (Zeroizing::new(item.text.to_string()), item.source.clone(), inner.settings.clone())
    };
    win::write(&text)?;
    add_item(app, &text, source, &settings)?; // moves it to the top
    let _ = app.emit(EVT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn clipboard_delete(app: AppHandle, clip: State<ClipState>, state: State<AppState>, id: i64) -> Result<(), String> {
    let mut inner = clip.inner.lock().unwrap();
    inner.items.retain(|i| i.id != id);
    state.store.lock().unwrap().clip_delete(id).map_err(|e| e.to_string())?;
    drop(inner);
    let _ = app.emit(EVT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn clipboard_clear(app: AppHandle, clip: State<ClipState>, state: State<AppState>) -> Result<(), String> {
    let mut inner = clip.inner.lock().unwrap();
    inner.items.clear();
    state.store.lock().unwrap().clip_delete_all().map_err(|e| e.to_string())?;
    drop(inner);
    let _ = app.emit(EVT_CHANGED, ());
    Ok(())
}

/// Pause recording for `minutes` (0 = until resumed), or resume with `None`.
#[tauri::command]
pub fn clipboard_pause(app: AppHandle, clip: State<ClipState>, minutes: Option<u32>) -> Result<ClipStatus, String> {
    let mut inner = clip.inner.lock().unwrap();
    inner.paused = match minutes {
        None => None,
        Some(0) => Some(None),
        Some(m) if m <= 24 * 60 => Some(Some(Instant::now() + Duration::from_secs(u64::from(m) * 60))),
        Some(_) => return Err("Pause for at most a day".into()),
    };
    let result = status(&mut inner);
    drop(inner);
    let _ = app.emit(EVT_CHANGED, ());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn settings_default_to_off_with_password_managers_ignored() {
        let s = ClipSettings::default();
        assert!(!s.enabled);
        assert_eq!(s.retention_days, 7);
        assert!(s.clear_sensitive);
        assert!(s.ignored_apps.contains(&"keepassxc.exe".to_string()));
        assert!(s.ignored_apps.contains(&"1password.exe".to_string()));
    }

    #[test]
    fn settings_round_trip_through_the_store() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        assert_eq!(ClipSettings::load(&store), ClipSettings::default());
        let custom = ClipSettings {
            enabled: true,
            retention_days: 30,
            clear_sensitive: false,
            ignored_apps: vec!["mybank.exe".into()],
        };
        custom.save(&store).unwrap();
        assert_eq!(ClipSettings::load(&store), custom);
    }

    #[test]
    fn settings_are_validated_and_normalised() {
        let ok = ClipSettings {
            ignored_apps: vec![" KeePassXC.exe ".into(), "keepassxc.exe".into(), "".into(), "My Bank (x64).exe".into()],
            ..ClipSettings::default()
        }
        .validated()
        .unwrap();
        assert_eq!(ok.ignored_apps, vec!["keepassxc.exe", "my bank (x64).exe"]);

        for bad in [
            ClipSettings { retention_days: 365, ..ClipSettings::default() },
            ClipSettings { ignored_apps: vec!["notepad".into()], ..ClipSettings::default() },
            ClipSettings { ignored_apps: vec!["..\\evil.exe".into()], ..ClipSettings::default() },
            ClipSettings { ignored_apps: (0..51).map(|i| format!("app{i}.exe")).collect(), ..ClipSettings::default() },
        ] {
            assert!(bad.validated().is_err());
        }
    }

    #[test]
    fn timed_pause_expires() {
        let mut inner = Inner {
            settings: ClipSettings::default(),
            items: Vec::new(),
            paused: Some(Some(Instant::now() - Duration::from_secs(1))),
        };
        assert!(!inner.is_paused(), "an elapsed pause ends");
        inner.paused = Some(None);
        assert!(inner.is_paused(), "an open-ended pause holds");
        inner.paused = Some(Some(Instant::now() + Duration::from_secs(60)));
        assert!(inner.is_paused(), "a pause that hasn't elapsed holds");
    }
}
