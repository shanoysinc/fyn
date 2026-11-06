//! Clipboard history: watches copies, keeps them encrypted, and pastes them back.
//!
//! Privacy, in layers (see README "Clipboard history"):
//! 1. Copies flagged "don't record" by the copying app (password managers) are skipped.
//! 2. Copies made in ignored apps are skipped.
//! 3. Known secret formats, card numbers and anything that looks like a password are
//!    never kept: not on disk, not in memory ([`classify`]). Optionally, a password-like
//!    copy is also cleared from the clipboard after a minute.
//! 4. Everything else is stored DPAPI-encrypted, pruned by age and count. Images are
//!    opt-in (text checks can't see inside a picture), capped at 50, and stored as
//!    encrypted files with an encrypted thumbnail in the database.
//!
//! Off until the user turns it on; turning it off deletes everything.

pub mod classify;
pub mod crypto;
pub mod image;
mod win;

use std::path::{Path, PathBuf};
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
use self::image::Rgba;
use crate::state::AppState;
use crate::store::{now, ClipRow, ImageMeta, Store};
use crate::window;

pub const EVT_CHANGED: &str = "fyn://clipboard-changed";

/// How long a password-like copy may stay on the clipboard (if that option is on).
const CLEAR_AFTER: Duration = Duration::from_secs(60);
const MAX_ITEMS: usize = 200;
const MAX_IMAGES: usize = 50;
/// Longest text sent to the UI for one item (the full text is still pasted).
const MAX_UI_CHARS: usize = 20_000;
/// Wait for the previous app to get focus back before pressing Ctrl+V in it.
const PASTE_DELAY: Duration = Duration::from_millis(150);

const KEY_ENABLED: &str = "clipboard_enabled";
const KEY_RETENTION: &str = "clipboard_retention_days";
const KEY_CLEAR: &str = "clipboard_clear_sensitive";
const KEY_IMAGES: &str = "clipboard_include_images";
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
    /// Keep copied images too (off by default: text checks can't see inside a picture).
    pub include_images: bool,
    pub ignored_apps: Vec<String>,
}

impl Default for ClipSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: 7,
            clear_sensitive: true,
            include_images: false,
            ignored_apps: DEFAULT_IGNORED.iter().map(|s| s.to_string()).collect(),
        }
    }
}

impl ClipSettings {
    fn load(store: &Store) -> Self {
        let d = Self::default();
        let flag = |key: &str, default: bool| store.get_setting(key).map_or(default, |v| v == "1");
        Self {
            enabled: flag(KEY_ENABLED, d.enabled),
            retention_days: store
                .get_setting(KEY_RETENTION)
                .and_then(|v| v.parse().ok())
                .filter(|v| RETENTIONS.contains(v))
                .unwrap_or(d.retention_days),
            clear_sensitive: flag(KEY_CLEAR, d.clear_sensitive),
            include_images: flag(KEY_IMAGES, d.include_images),
            ignored_apps: store
                .get_setting(KEY_IGNORED)
                .map(|v| v.lines().filter(|l| !l.is_empty()).map(str::to_string).collect())
                .unwrap_or(d.ignored_apps),
        }
    }

    fn save(&self, store: &Store) -> rusqlite::Result<()> {
        let flag = |b: bool| if b { "1" } else { "0" };
        store.set_setting(KEY_ENABLED, flag(self.enabled))?;
        store.set_setting(KEY_RETENTION, &self.retention_days.to_string())?;
        store.set_setting(KEY_CLEAR, flag(self.clear_sensitive))?;
        store.set_setting(KEY_IMAGES, flag(self.include_images))?;
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

enum Content {
    Text(Zeroizing<String>),
    /// The full image is an encrypted file on disk; only its thumbnail is in memory.
    Image { meta: ImageMeta, thumb_png: Vec<u8> },
}

struct Item {
    id: i64,
    content: Content,
    source: Option<String>,
    created: i64,
}

impl Item {
    fn is_text(&self, text: &str) -> bool {
        matches!(&self.content, Content::Text(t) if **t == *text)
    }

    fn image_hash(&self) -> Option<u64> {
        match &self.content {
            Content::Image { meta, .. } => Some(meta.hash),
            Content::Text(_) => None,
        }
    }
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
    /// Encrypted image files, one per image item.
    images_dir: PathBuf,
}

impl ClipState {
    fn image_path(&self, id: i64) -> PathBuf {
        self.images_dir.join(format!("{id}.png.enc"))
    }

    fn delete_image_file(&self, id: i64) {
        let _ = std::fs::remove_file(self.image_path(id));
    }

    fn delete_all_image_files(&self) {
        let _ = std::fs::remove_dir_all(&self.images_dir);
        let _ = std::fs::create_dir_all(&self.images_dir);
    }

    /// Decrypt an image item's PNG from disk.
    fn read_image(&self, id: i64) -> Result<Zeroizing<Vec<u8>>, String> {
        let cipher = std::fs::read(self.image_path(id)).map_err(|_| "That image is no longer available")?;
        crypto::unprotect_bytes(&cipher)
    }
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static MONITOR_HWND: AtomicIsize = AtomicIsize::new(0);

/// Load settings and (if enabled) the saved history, then start watching the clipboard.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppState>();
    let images_dir = state.data_dir.join("clipboard");
    let _ = std::fs::create_dir_all(&images_dir);
    let store = state.store.lock().unwrap();
    let settings = ClipSettings::load(&store);
    let items = if settings.enabled { load_items(&store, &images_dir) } else { Vec::new() };
    drop(store);

    app.manage(ClipState { inner: Mutex::new(Inner { settings, items, paused: None }), images_dir });
    let _ = APP.set(app.clone());
    std::thread::Builder::new()
        .name("fyn-clipboard".into())
        .spawn(run_monitor)
        .expect("failed to start clipboard monitor");
}

/// Decrypt the saved history. Rows that can't be decrypted (e.g. another Windows user's)
/// or whose image file is gone are deleted.
fn load_items(store: &Store, images_dir: &Path) -> Vec<Item> {
    let mut items = Vec::new();
    for row in store.clip_all() {
        let content = match row.image {
            None => crypto::unprotect(&row.data).ok().map(Content::Text),
            Some(meta) => {
                let file_exists = images_dir.join(format!("{}.png.enc", row.id)).exists();
                crypto::unprotect_bytes(&row.data)
                    .ok()
                    .filter(|_| file_exists)
                    .map(|thumb| Content::Image { meta, thumb_png: thumb.to_vec() })
            }
        };
        match content {
            Some(content) => items.push(Item { id: row.id, content, source: row.source, created: row.created }),
            None => {
                let _ = store.clip_delete(row.id);
                let _ = std::fs::remove_file(images_dir.join(format!("{}.png.enc", row.id)));
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

    let changed = match win::read(hwnd, settings.include_images) {
        // `text` is wiped when it goes out of scope, whichever branch runs.
        Ok(win::Read::Text(text)) => match classify::classify(&text) {
            Class::Normal => add_text(app, &text, source, &settings).is_ok(),
            // Looks like a password: never kept, anywhere. Optionally take it off the
            // clipboard too, a minute from now, if nothing else has been copied by then.
            Class::Sensitive => {
                if settings.clear_sensitive {
                    clear_later(seq);
                }
                false
            }
            Class::Never(_) => false,
        },
        Ok(win::Read::Image { image, png }) => add_image(app, &image, png, source, &settings).is_ok(),
        _ => false, // excluded by the copying app, nothing usable, or the clipboard was busy
    };
    if changed {
        let _ = app.emit(EVT_CHANGED, ());
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

/// Save a text item (encrypted), moving an identical older one to the top.
fn add_text(app: &AppHandle, text: &str, source: Option<String>, settings: &ClipSettings) -> Result<(), String> {
    let clip = app.state::<ClipState>();
    let state = app.state::<AppState>();
    let mut inner = clip.inner.lock().unwrap();
    let store = state.store.lock().unwrap();

    let data = crypto::protect(text)?;
    let old: Vec<i64> = inner.items.iter().filter(|i| i.is_text(text)).map(|i| i.id).collect();
    remove_items(&clip, &mut inner, &store, &old);
    let row = ClipRow { id: 0, created: now(), source, data, image: None };
    let id = store.clip_insert(&row).map_err(|e| e.to_string())?;
    inner.items.insert(0, Item { id, content: Content::Text(Zeroizing::new(text.to_string())), source: row.source, created: row.created });
    prune(&clip, &mut inner, &store, settings);
    Ok(())
}

/// Save an image: the PNG as an encrypted file, an encrypted thumbnail in the database.
/// The same image copied again moves to the top instead of being stored twice.
fn add_image(
    app: &AppHandle,
    img: &Rgba,
    png: Option<Vec<u8>>,
    source: Option<String>,
    settings: &ClipSettings,
) -> Result<(), String> {
    let png = match png {
        Some(png) => png,
        None => image::encode_png(img)?,
    };
    if png.len() > image::MAX_PNG_BYTES {
        return Err("Image too large to keep".into());
    }
    let meta = ImageMeta { width: img.width, height: img.height, bytes: png.len() as u64, hash: crate::win::fnv1a(&[&png]) };
    let thumb_png = image::encode_png(&image::thumbnail(img, image::THUMB_SIZE))?;
    let file = crypto::protect_bytes(&png)?;
    let data = crypto::protect_bytes(&thumb_png)?;

    let clip = app.state::<ClipState>();
    let state = app.state::<AppState>();
    let mut inner = clip.inner.lock().unwrap();
    let store = state.store.lock().unwrap();

    let old: Vec<i64> = inner.items.iter().filter(|i| i.image_hash() == Some(meta.hash)).map(|i| i.id).collect();
    remove_items(&clip, &mut inner, &store, &old);
    let row = ClipRow { id: 0, created: now(), source, data, image: Some(meta) };
    let id = store.clip_insert(&row).map_err(|e| e.to_string())?;
    if let Err(e) = write_atomic(&clip.image_path(id), &file) {
        let _ = store.clip_delete(id);
        return Err(format!("Couldn't save image: {e}"));
    }
    inner.items.insert(0, Item { id, content: Content::Image { meta, thumb_png }, source: row.source, created: row.created });
    prune(&clip, &mut inner, &store, settings);
    Ok(())
}

/// Write via a temporary file so a crash never leaves a half-written image.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Remove items (rows, image files and memory).
fn remove_items(clip: &ClipState, inner: &mut Inner, store: &Store, ids: &[i64]) {
    for &id in ids {
        let _ = store.clip_delete(id);
        clip.delete_image_file(id);
    }
    inner.items.retain(|i| !ids.contains(&i.id));
}

/// Apply retention: age, total count and image count.
fn prune(clip: &ClipState, inner: &mut Inner, store: &Store, settings: &ClipSettings) {
    let cutoff = now() - i64::from(settings.retention_days) * 86_400;
    let removed = store.clip_prune(cutoff, MAX_ITEMS, MAX_IMAGES).unwrap_or_default();
    remove_items(clip, inner, store, &removed);
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    id: i64,
    /// "text" or "image".
    kind: &'static str,
    /// The text; empty for images.
    text: String,
    truncated: bool,
    chars: usize,
    source: Option<String>,
    created: i64,
    width: Option<u32>,
    height: Option<u32>,
    /// Image size on disk (PNG), in bytes.
    bytes: Option<u64>,
    /// Small preview of an image, as a data: URL.
    thumb: Option<String>,
    /// Cached icon (file path) of the app it was copied from, if Fyn knows that app.
    source_icon: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipStatus {
    #[serde(flatten)]
    settings: ClipSettings,
    paused: bool,
    /// Unix seconds when a timed pause ends.
    paused_until: Option<i64>,
    image_count: usize,
    /// Space used by saved images, in bytes.
    image_bytes: u64,
}

fn status(inner: &mut Inner) -> ClipStatus {
    let paused = inner.is_paused();
    let paused_until = match inner.paused {
        Some(Some(until)) => Some(now() + until.saturating_duration_since(Instant::now()).as_secs() as i64),
        _ => None,
    };
    let images = inner.items.iter().filter_map(|i| match &i.content {
        Content::Image { meta, .. } => Some(meta.bytes),
        Content::Text(_) => None,
    });
    let (image_count, image_bytes) = images.fold((0, 0), |(n, b), bytes| (n + 1, b + bytes));
    ClipStatus { settings: inner.settings.clone(), paused, paused_until, image_count, image_bytes }
}

#[tauri::command]
pub fn clipboard_status(clip: State<ClipState>) -> ClipStatus {
    status(&mut clip.inner.lock().unwrap())
}

/// Change settings. Turning history off deletes everything it kept; turning images off
/// deletes the saved images.
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
        clip.delete_all_image_files();
    } else {
        if !settings.include_images {
            let images: Vec<i64> = inner.items.iter().filter(|i| i.image_hash().is_some()).map(|i| i.id).collect();
            remove_items(&clip, &mut inner, &store, &images);
        }
        prune(&clip, &mut inner, &store, &settings);
    }
    inner.settings = settings;
    let result = status(&mut inner);
    drop((inner, store));
    let _ = app.emit(EVT_CHANGED, ());
    Ok(result)
}

/// Icon of each installed app by its executable's file name ("code.exe" -> cached PNG),
/// so clipboard items can show the app they were copied from.
fn icons_by_exe(apps: &[crate::indexer::App]) -> std::collections::HashMap<String, String> {
    apps.iter()
        .filter_map(|a| {
            let exe = a.target.as_deref()?.rsplit(['\\', '/']).next()?.to_lowercase();
            Some((exe, a.icon.clone()?))
        })
        .collect()
}

#[tauri::command]
pub fn clipboard_list(clip: State<ClipState>, state: State<AppState>) -> Vec<ClipEntry> {
    let icons = icons_by_exe(&state.apps());
    let inner = clip.inner.lock().unwrap();
    inner
        .items
        .iter()
        .map(|i| {
            let base = ClipEntry {
                id: i.id,
                kind: "text",
                text: String::new(),
                truncated: false,
                chars: 0,
                source: i.source.clone(),
                source_icon: i.source.as_ref().and_then(|s| icons.get(s).cloned()),
                created: i.created,
                width: None,
                height: None,
                bytes: None,
                thumb: None,
            };
            match &i.content {
                Content::Text(text) => {
                    let chars = text.chars().count();
                    ClipEntry {
                        text: text.chars().take(MAX_UI_CHARS).collect(),
                        truncated: chars > MAX_UI_CHARS,
                        chars,
                        ..base
                    }
                }
                Content::Image { meta, thumb_png } => ClipEntry {
                    kind: "image",
                    width: Some(meta.width),
                    height: Some(meta.height),
                    bytes: Some(meta.bytes),
                    thumb: Some(image::png_data_url(thumb_png)),
                    ..base
                },
            }
        })
        .collect()
}

/// The full image of an image item, as a data: URL (decrypted on demand, not kept).
#[tauri::command(async)]
pub fn clipboard_image(clip: State<ClipState>, id: i64) -> Result<String, String> {
    let png = clip.read_image(id)?;
    Ok(image::png_data_url(&png))
}

/// Copy an item back onto the clipboard (and to the top of the history).
#[tauri::command(async)]
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
        let text = match &item.content {
            Content::Text(t) => Some(Zeroizing::new(t.to_string())),
            Content::Image { .. } => None,
        };
        (text, item.source.clone(), inner.settings.clone())
    };
    match text {
        Some(text) => {
            win::write(&text)?;
            add_text(app, &text, source, &settings)?; // moves it to the top
        }
        None => {
            let png = clip.read_image(id)?;
            let img = image::decode_png(&png).ok_or("That image is damaged")?;
            win::write_image(&png, &img)?;
            add_image(app, &img, Some(png.to_vec()), source, &settings)?; // moves it to the top
        }
    }
    let _ = app.emit(EVT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn clipboard_delete(app: AppHandle, clip: State<ClipState>, state: State<AppState>, id: i64) -> Result<(), String> {
    let mut inner = clip.inner.lock().unwrap();
    remove_items(&clip, &mut inner, &state.store.lock().unwrap(), &[id]);
    drop(inner);
    let _ = app.emit(EVT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn clipboard_clear(app: AppHandle, clip: State<ClipState>, state: State<AppState>) -> Result<(), String> {
    let mut inner = clip.inner.lock().unwrap();
    inner.items.clear();
    state.store.lock().unwrap().clip_delete_all().map_err(|e| e.to_string())?;
    clip.delete_all_image_files();
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

    #[test]
    fn settings_default_to_off_without_images_and_with_password_managers_ignored() {
        let s = ClipSettings::default();
        assert!(!s.enabled);
        assert!(!s.include_images);
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
            include_images: true,
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

    #[test]
    fn source_apps_are_matched_to_their_icons_by_exe_name() {
        use crate::indexer::{App, AppKind};
        let app = |target: Option<&str>, icon: Option<&str>| App {
            id: "x".into(),
            name: "x".into(),
            kind: AppKind::Desktop,
            launch: "x".into(),
            target: target.map(str::to_string),
            icon: icon.map(str::to_string),
            stamp: 0,
        };
        let icons = icons_by_exe(&[
            app(Some(r"C:\Program Files\Microsoft VS Code\Code.exe"), Some(r"C:\icons\code.png")),
            app(Some(r"C:\Tools\noicon.exe"), None),
            app(None, Some(r"C:\icons\store.png")),
        ]);
        assert_eq!(icons.get("code.exe").map(String::as_str), Some(r"C:\icons\code.png"));
        assert_eq!(icons.len(), 1, "apps without a known exe or icon are skipped");
    }

    #[test]
    fn saved_items_load_back_and_orphans_are_cleaned_up() {
        let dir = std::env::temp_dir().join(format!("fyn-clip-load-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(Path::new(":memory:")).unwrap();

        let text = ClipRow { id: 0, created: 1, source: None, data: crypto::protect("hello").unwrap(), image: None };
        store.clip_insert(&text).unwrap();
        let meta = ImageMeta { width: 2, height: 2, bytes: 10, hash: 42 };
        let thumb = crypto::protect_bytes(b"thumb-png").unwrap();
        let kept = store.clip_insert(&ClipRow { id: 0, created: 2, source: None, data: thumb.clone(), image: Some(meta) }).unwrap();
        std::fs::write(dir.join(format!("{kept}.png.enc")), b"x").unwrap();
        // An image row whose file is missing, and a row that can't be decrypted.
        store.clip_insert(&ClipRow { id: 0, created: 3, source: None, data: thumb, image: Some(meta) }).unwrap();
        store.clip_insert(&ClipRow { id: 0, created: 4, source: None, data: b"garbage".to_vec(), image: None }).unwrap();

        let items = load_items(&store, &dir);
        assert_eq!(items.len(), 2);
        assert!(matches!(&items[0].content, Content::Image { thumb_png, .. } if thumb_png == b"thumb-png"));
        assert!(items[1].is_text("hello"));
        assert_eq!(store.clip_all().len(), 2, "broken rows are deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
