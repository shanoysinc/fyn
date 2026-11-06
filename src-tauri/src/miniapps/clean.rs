//! Clean Windows: frees disk space from caches and leftovers.
//!
//! Safety rules (all enforced here, not in the UI):
//! * Only fixed locations, computed from the user's environment ([`Roots`]). The UI sends
//!   category ids and item ids from a scan; never paths.
//! * Never follows symlinks or junctions out of those locations.
//! * Anything whose path contains a *protected* word (default: "beacon", "emr") is never
//!   deleted: emulators, the system images they use, and files under such folders.
//! * Files in use are skipped, not forced. Temp files must be older than a day.
//! * Scanning is read-only; deleting only happens in [`clean`], after the user confirms.

use std::collections::{BTreeSet, HashSet};
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

use crate::system;
use crate::win::wide;

/// Temp files younger than this may belong to something running right now.
const TEMP_MIN_AGE: Duration = Duration::from_secs(24 * 3600);
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
pub const DEFAULT_PROTECTED: [&str; 2] = ["beacon", "emr"];

/// Where things live, from the environment (or a test folder).
#[derive(Clone, Debug, Default)]
pub struct Roots {
    pub temp: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub android_sdk: Option<PathBuf>,
    pub avd_home: Option<PathBuf>,
}

impl Roots {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute());
        let local = var("LOCALAPPDATA");
        let home = var("USERPROFILE");
        Self {
            temp: var("TEMP").or_else(|| local.as_ref().map(|l| l.join("Temp"))),
            android_sdk: var("ANDROID_HOME")
                .or_else(|| var("ANDROID_SDK_ROOT"))
                .or_else(|| local.as_ref().map(|l| l.join("Android").join("Sdk"))),
            avd_home: var("ANDROID_AVD_HOME").or_else(|| home.as_ref().map(|h| h.join(".android").join("avd"))),
            local_app_data: local,
            home,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// Delete files inside these folders (the folders themselves stay).
    Folders { min_age: Option<Duration> },
    RecycleBin,
    /// Individual Android emulators, chosen one by one.
    Avds,
    /// Individual Android SDK system images, chosen one by one.
    SystemImages,
}

struct Category {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    /// Selected unless the user turned it off (optional ones start off).
    default_on: bool,
    kind: Kind,
}

const CATEGORIES: [Category; 11] = [
    Category {
        id: "temp",
        title: "Temporary files",
        description: "Leftovers in your Temp folder older than a day",
        default_on: true,
        kind: Kind::Folders { min_age: Some(TEMP_MIN_AGE) },
    },
    Category {
        id: "crash",
        title: "Crash dumps & error reports",
        description: "Memory dumps and Windows Error Reporting files",
        default_on: true,
        kind: Kind::Folders { min_age: None },
    },
    Category {
        id: "recycle",
        title: "Recycle Bin",
        description: "Everything in the Recycle Bin, on all drives",
        default_on: true,
        kind: Kind::RecycleBin,
    },
    Category {
        id: "npm",
        title: "npm cache",
        description: "Downloaded packages; npm fetches them again when needed",
        default_on: true,
        kind: Kind::Folders { min_age: None },
    },
    Category {
        id: "yarn",
        title: "Yarn cache",
        description: "Downloaded packages; Yarn fetches them again when needed",
        default_on: true,
        kind: Kind::Folders { min_age: None },
    },
    Category {
        id: "pnpm",
        title: "pnpm store",
        description: "Shared package store; pnpm refills it when needed",
        default_on: true,
        kind: Kind::Folders { min_age: None },
    },
    Category {
        id: "bun",
        title: "Bun cache",
        description: "Downloaded packages; Bun fetches them again when needed",
        default_on: true,
        kind: Kind::Folders { min_age: None },
    },
    Category {
        id: "pip",
        title: "pip cache",
        description: "Downloaded Python packages",
        default_on: true,
        kind: Kind::Folders { min_age: None },
    },
    Category {
        id: "gradle",
        title: "Gradle caches",
        description: "Build caches and daemon logs; the next build re-downloads what it needs",
        default_on: true,
        kind: Kind::Folders { min_age: None },
    },
    Category {
        id: "avd",
        title: "Android emulators",
        description: "Virtual devices you pick (protected ones are never touched)",
        default_on: false,
        kind: Kind::Avds,
    },
    Category {
        id: "sdk-images",
        title: "Android system images",
        description: "Emulator images you pick (ones used by protected emulators are kept)",
        default_on: false,
        kind: Kind::SystemImages,
    },
];

fn category(id: &str) -> Option<&'static Category> {
    CATEGORIES.iter().find(|c| c.id == id)
}

/// The folders a folder-type category cleans.
fn folders(id: &str, r: &Roots) -> Vec<PathBuf> {
    let local = |p: &[&str]| r.local_app_data.as_ref().map(|l| p.iter().fold(l.clone(), |acc, s| acc.join(s)));
    let home = |p: &[&str]| r.home.as_ref().map(|h| p.iter().fold(h.clone(), |acc, s| acc.join(s)));
    let list = match id {
        "temp" => vec![r.temp.clone()],
        "crash" => vec![
            local(&["CrashDumps"]),
            local(&["Microsoft", "Windows", "WER", "ReportArchive"]),
            local(&["Microsoft", "Windows", "WER", "ReportQueue"]),
        ],
        "npm" => vec![local(&["npm-cache"])],
        "yarn" => vec![local(&["Yarn", "Cache"])],
        "pnpm" => vec![local(&["pnpm", "store"])],
        "bun" => vec![home(&[".bun", "install", "cache"])],
        "pip" => vec![local(&["pip", "Cache"])],
        "gradle" => vec![home(&[".gradle", "caches"]), home(&[".gradle", "daemon"])],
        _ => vec![],
    };
    list.into_iter().flatten().collect()
}

// ---------- settings ----------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanSettings {
    /// Category ids that are switched on.
    pub enabled: Vec<String>,
    /// Words that protect anything whose name or path contains them.
    pub protected: Vec<String>,
}

impl Default for CleanSettings {
    fn default() -> Self {
        Self {
            enabled: CATEGORIES.iter().filter(|c| c.default_on).map(|c| c.id.to_string()).collect(),
            protected: DEFAULT_PROTECTED.iter().map(|s| s.to_string()).collect(),
        }
    }
}

impl CleanSettings {
    pub fn validated(self) -> Result<Self, String> {
        let mut enabled = Vec::new();
        for id in self.enabled {
            if category(&id).is_none() {
                return Err(format!("Unknown category \"{id}\""));
            }
            if !enabled.contains(&id) {
                enabled.push(id);
            }
        }
        let mut protected = Vec::new();
        for word in self.protected {
            let word = word.trim().to_lowercase();
            if word.is_empty() {
                continue;
            }
            if word.len() > 40 || word.contains(['/', '\\', ':', '*', '?']) {
                return Err(format!("\"{word}\" can't be used as a protected name"));
            }
            if !protected.contains(&word) {
                protected.push(word);
            }
        }
        if protected.len() > 30 {
            return Err("Too many protected names".into());
        }
        Ok(Self { enabled, protected })
    }
}

fn is_protected(path: &Path, protected: &[String]) -> bool {
    let p = path.to_string_lossy().to_lowercase();
    protected.iter().any(|w| p.contains(w.as_str()))
}

// ---------- walking ----------

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub files: u64,
    pub bytes: u64,
}

impl Tally {
    fn add(&mut self, other: Tally) {
        self.files += other.files;
        self.bytes += other.bytes;
    }
}

/// Links and junctions are never entered or deleted through.
fn is_link(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// Files under `root` that may be deleted: real files only, not protected, old enough.
fn deletable_files(root: &Path, min_age: Option<Duration>, protected: &[String]) -> Vec<(PathBuf, u64)> {
    let now = SystemTime::now();
    let mut out = Vec::new();
    let walker = walkdir::WalkDir::new(root).follow_links(false).min_depth(1).into_iter();
    // Don't descend into links/junctions or protected folders at all.
    let walker = walker.filter_entry(|e| {
        let link = std::fs::symlink_metadata(e.path()).map(|m| is_link(&m)).unwrap_or(true);
        !link && !is_protected(e.path(), protected)
    });
    for entry in walker.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() || is_link(&meta) {
            continue;
        }
        if let Some(age) = min_age {
            let modified = meta.modified().unwrap_or(now);
            if now.duration_since(modified).unwrap_or_default() < age {
                continue;
            }
        }
        out.push((entry.into_path(), meta.len()));
    }
    out
}

fn tally(files: &[(PathBuf, u64)]) -> Tally {
    Tally { files: files.len() as u64, bytes: files.iter().map(|(_, b)| b).sum() }
}

fn dir_tally(dir: &Path) -> Tally {
    tally(&deletable_files(dir, None, &[]))
}

/// Delete files (skipping ones in use), then folders left empty below `root`.
fn delete_files(root: &Path, files: &[(PathBuf, u64)]) -> (Tally, u64) {
    let mut freed = Tally::default();
    let mut skipped = 0;
    for (path, bytes) in files {
        // Make read-only files deletable (common in caches).
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            if perms.readonly() {
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(path, perms);
            }
        }
        match std::fs::remove_file(path) {
            Ok(()) => freed.add(Tally { files: 1, bytes: *bytes }),
            Err(_) => skipped += 1,
        }
    }
    remove_empty_dirs(root);
    (freed, skipped)
}

/// Remove empty folders below `root` (deepest first), never `root` itself or links.
fn remove_empty_dirs(root: &Path) {
    let dirs: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .contents_first(true)
        .into_iter()
        .flatten()
        .filter(|e| std::fs::symlink_metadata(e.path()).map(|m| m.is_dir() && !is_link(&m)).unwrap_or(false))
        .map(|e| e.into_path())
        .collect();
    for dir in dirs {
        let _ = std::fs::remove_dir(dir); // only succeeds when empty
    }
}

// ---------- Android ----------

#[derive(Clone, Debug, PartialEq, Eq)]
struct Avd {
    name: String,
    dir: PathBuf,
    ini: PathBuf,
    /// System image it uses, e.g. "android-34/google_apis/x86_64".
    image: Option<String>,
}

fn list_avds(r: &Roots) -> Vec<Avd> {
    let Some(home) = &r.avd_home else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    let mut avds: Vec<Avd> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension()? != "ini" {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let dir = home.join(format!("{name}.avd"));
            let image = std::fs::read_to_string(dir.join("config.ini")).ok().and_then(|cfg| {
                cfg.lines().find_map(|l| {
                    let v = l.strip_prefix("image.sysdir.1")?.trim_start().strip_prefix('=')?;
                    let v = v.trim().replace('\\', "/");
                    let v = v.trim_matches('/').strip_prefix("system-images/")?.to_string();
                    Some(v)
                })
            });
            Some(Avd { name, dir, ini: path, image })
        })
        .collect();
    avds.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    avds
}

/// System images as ("android-34/google_apis/x86_64", folder).
fn list_images(r: &Roots) -> Vec<(String, PathBuf)> {
    let Some(sdk) = &r.android_sdk else { return Vec::new() };
    let base = sdk.join("system-images");
    let mut out = Vec::new();
    let dirs = |p: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(p)
            .map(|d| {
                d.flatten()
                    .map(|e| e.path())
                    .filter(|p| std::fs::symlink_metadata(p).map(|m| m.is_dir() && !is_link(&m)).unwrap_or(false))
                    .collect()
            })
            .unwrap_or_default()
    };
    for api in dirs(&base) {
        for tag in dirs(&api) {
            for abi in dirs(&tag) {
                let id = abi.strip_prefix(&base).unwrap_or(&abi).to_string_lossy().replace('\\', "/");
                out.push((id, abi));
            }
        }
    }
    out.sort();
    out
}

/// Images an emulator with a protected name depends on are protected too.
fn images_used_by_protected_avds(r: &Roots, protected: &[String]) -> HashSet<String> {
    list_avds(r)
        .into_iter()
        .filter(|a| is_protected(Path::new(&a.name), protected))
        .filter_map(|a| a.image)
        .collect()
}

// ---------- scan ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    /// "avd:<name>" or "image:<id>".
    pub id: String,
    pub name: String,
    pub bytes: u64,
    pub protected: bool,
    /// Why it's protected or what uses it.
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCategory {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub enabled: bool,
    pub optional: bool,
    /// Something to clean exists on this PC.
    pub available: bool,
    pub files: u64,
    pub bytes: u64,
    /// Emulators / system images, chosen one by one.
    pub items: Vec<ScanItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub free: u64,
    pub total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub categories: Vec<ScanCategory>,
    pub disk: Option<Disk>,
}

/// Read-only: what each category could free.
pub fn scan(r: &Roots, settings: &CleanSettings) -> ScanReport {
    let protected = &settings.protected;
    // Categories are independent, so scan them in parallel; Gradle caches can be big.
    let categories = std::thread::scope(|s| {
        let handles: Vec<_> = CATEGORIES
            .iter()
            .map(|c| s.spawn(move || scan_category(c, r, protected, settings.enabled.iter().any(|e| e == c.id))))
            .collect();
        handles.into_iter().map(|h| h.join().expect("scan thread")).collect()
    });
    ScanReport { categories, disk: system_disk() }
}

fn scan_category(c: &'static Category, r: &Roots, protected: &[String], enabled: bool) -> ScanCategory {
    let mut out = ScanCategory {
        id: c.id,
        title: c.title,
        description: c.description,
        enabled,
        optional: !c.default_on,
        available: false,
        files: 0,
        bytes: 0,
        items: Vec::new(),
    };
    match c.kind {
        Kind::Folders { min_age } => {
            let mut t = Tally::default();
            for dir in folders(c.id, r).iter().filter(|d| d.is_dir()) {
                out.available = true;
                t.add(tally(&deletable_files(dir, min_age, protected)));
            }
            out.files = t.files;
            out.bytes = t.bytes;
        }
        Kind::RecycleBin => {
            if let Ok((files, bytes)) = system::recycle_bin_size() {
                out.available = true;
                out.files = files;
                out.bytes = bytes;
            }
        }
        Kind::Avds => {
            for avd in list_avds(r) {
                let is_prot = is_protected(Path::new(&avd.name), protected);
                let bytes = dir_tally(&avd.dir).bytes;
                out.items.push(ScanItem {
                    id: format!("avd:{}", avd.name),
                    name: avd.name.replace('_', " "),
                    bytes,
                    protected: is_prot,
                    note: avd.image.map(|i| format!("Uses {i}")),
                });
            }
            out.available = !out.items.is_empty();
        }
        Kind::SystemImages => {
            let in_use = images_used_by_protected_avds(r, protected);
            for (id, dir) in list_images(r) {
                let used = in_use.contains(&id);
                let is_prot = used || is_protected(Path::new(&id), protected);
                out.items.push(ScanItem {
                    bytes: dir_tally(&dir).bytes,
                    name: id.replace('/', " · "),
                    note: used.then(|| "Used by a protected emulator".to_string()),
                    id: format!("image:{id}"),
                    protected: is_prot,
                });
            }
            out.available = !out.items.is_empty();
        }
    }
    out
}

fn system_disk() -> Option<Disk> {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let root = wide(&format!("{drive}\\"));
    let (mut free, mut total) = (0u64, 0u64);
    unsafe { GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), Some(&mut free), Some(&mut total), None) }.ok()?;
    Some(Disk { free, total })
}

// ---------- clean ----------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub freed_bytes: u64,
    pub deleted_files: u64,
    /// Files that were in use or couldn't be deleted.
    pub skipped_files: u64,
    pub errors: Vec<String>,
}

/// Delete what's selected: whole categories by id, and emulators / images by item id.
/// Everything is re-derived here from [`Roots`]; ids that don't match are ignored.
pub fn clean(r: &Roots, settings: &CleanSettings, categories: &[String], items: &[String]) -> CleanReport {
    let protected = &settings.protected;
    let mut report = CleanReport::default();
    let wanted: BTreeSet<&str> = categories.iter().map(String::as_str).collect();
    let mut add = |(freed, skipped): (Tally, u64)| {
        report.freed_bytes += freed.bytes;
        report.deleted_files += freed.files;
        report.skipped_files += skipped;
    };

    for c in CATEGORIES.iter().filter(|c| wanted.contains(c.id)) {
        match c.kind {
            Kind::Folders { min_age } => {
                for dir in folders(c.id, r).iter().filter(|d| d.is_dir()) {
                    add(delete_files(dir, &deletable_files(dir, min_age, protected)));
                }
            }
            Kind::RecycleBin => {
                let before = system::recycle_bin_size().unwrap_or_default();
                match system::empty_recycle_bin() {
                    Ok(_) => add((Tally { files: before.0, bytes: before.1 }, 0)),
                    Err(e) => report.errors.push(e),
                }
            }
            Kind::Avds | Kind::SystemImages => {} // chosen item by item below
        }
    }

    let items: BTreeSet<&str> = items.iter().map(String::as_str).collect();
    for avd in list_avds(r) {
        if !items.contains(format!("avd:{}", avd.name).as_str()) || is_protected(Path::new(&avd.name), protected) {
            continue;
        }
        if !inside(&avd.dir, r.avd_home.as_deref()) {
            continue;
        }
        add(delete_files(&avd.dir, &deletable_files(&avd.dir, None, &[])));
        let _ = std::fs::remove_dir(&avd.dir);
        let _ = std::fs::remove_file(&avd.ini);
    }
    let in_use = images_used_by_protected_avds(r, protected);
    let sdk_images = r.android_sdk.as_ref().map(|s| s.join("system-images"));
    for (id, dir) in list_images(r) {
        let selected = items.contains(format!("image:{id}").as_str());
        if !selected || in_use.contains(&id) || is_protected(Path::new(&id), protected) {
            continue;
        }
        if !inside(&dir, sdk_images.as_deref()) {
            continue;
        }
        add(delete_files(&dir, &deletable_files(&dir, None, &[])));
        let _ = std::fs::remove_dir(&dir);
    }
    report
}

/// `path` is strictly inside `root` with no ".." tricks.
fn inside(path: &Path, root: Option<&Path>) -> bool {
    let Some(root) = root else { return false };
    path.starts_with(root)
        && path != root
        && !path.components().any(|c| matches!(c, Component::ParentDir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A throwaway folder tree standing in for the user's profile.
    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("fyn-clean-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, rel: &str, bytes: usize) -> PathBuf {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, vec![b'x'; bytes]).unwrap();
            p
        }

        fn roots(&self) -> Roots {
            Roots {
                temp: Some(self.0.join("Local").join("Temp")),
                local_app_data: Some(self.0.join("Local")),
                home: Some(self.0.join("Home")),
                android_sdk: Some(self.0.join("Local").join("Android").join("Sdk")),
                avd_home: Some(self.0.join("Home").join(".android").join("avd")),
            }
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn age(path: &Path, days: u64) {
        let when = SystemTime::now() - Duration::from_secs(days * 86_400);
        fs::File::options().write(true).open(path).unwrap().set_modified(when).unwrap();
    }

    fn settings() -> CleanSettings {
        CleanSettings::default()
    }

    fn cat<'a>(report: &'a ScanReport, id: &str) -> &'a ScanCategory {
        report.categories.iter().find(|c| c.id == id).unwrap()
    }

    #[test]
    fn defaults_turn_on_safe_categories_and_protect_beacon_and_emr() {
        let s = CleanSettings::default();
        for id in ["temp", "crash", "recycle", "npm", "gradle"] {
            assert!(s.enabled.contains(&id.to_string()), "{id} on by default");
        }
        for id in ["avd", "sdk-images"] {
            assert!(!s.enabled.contains(&id.to_string()), "{id} off by default");
        }
        assert_eq!(s.protected, vec!["beacon", "emr"]);
    }

    #[test]
    fn settings_are_validated() {
        let ok = CleanSettings { enabled: vec!["npm".into(), "npm".into()], protected: vec![" Beacon ".into(), "".into()] }
            .validated()
            .unwrap();
        assert_eq!(ok.enabled, vec!["npm"]);
        assert_eq!(ok.protected, vec!["beacon"]);
        assert!(CleanSettings { enabled: vec!["windows".into()], protected: vec![] }.validated().is_err());
        assert!(CleanSettings { enabled: vec![], protected: vec!["C:\\".into()] }.validated().is_err());
    }

    #[test]
    fn temp_files_must_be_older_than_a_day() {
        let sb = Sandbox::new("temp");
        let old = sb.file("Local/Temp/old.log", 100);
        age(&old, 3);
        let fresh = sb.file("Local/Temp/installer-in-progress.tmp", 50);
        let r = sb.roots();

        let report = scan(&r, &settings());
        assert_eq!(cat(&report, "temp").bytes, 100);

        let done = clean(&r, &settings(), &["temp".into()], &[]);
        assert_eq!(done.freed_bytes, 100);
        assert!(!old.exists());
        assert!(fresh.exists(), "recent temp files are left alone");
        assert!(r.temp.unwrap().exists(), "the Temp folder itself stays");
    }

    #[test]
    fn caches_are_emptied_and_empty_folders_removed() {
        let sb = Sandbox::new("caches");
        sb.file("Local/npm-cache/_cacache/content/aa/bb", 300);
        sb.file("Home/.gradle/caches/modules-2/files/x.jar", 700);
        sb.file("Home/.gradle/daemon/8.5/daemon.log", 10);
        let r = sb.roots();

        let report = scan(&r, &settings());
        assert_eq!(cat(&report, "npm").bytes, 300);
        assert_eq!(cat(&report, "gradle").bytes, 710);
        assert!(!cat(&report, "yarn").available, "missing caches are reported as unavailable");

        let done = clean(&r, &settings(), &["npm".into(), "gradle".into()], &[]);
        assert_eq!(done.freed_bytes, 1010);
        assert_eq!(done.deleted_files, 3);
        assert!(sb.0.join("Local/npm-cache").exists());
        assert!(!sb.0.join("Local/npm-cache/_cacache").exists(), "emptied folders go too");
    }

    #[test]
    fn only_selected_categories_are_cleaned() {
        let sb = Sandbox::new("selected");
        let npm = sb.file("Local/npm-cache/a", 1);
        let pip = sb.file("Local/pip/Cache/b", 1);
        clean(&sb.roots(), &settings(), &["npm".into()], &[]);
        assert!(!npm.exists());
        assert!(pip.exists());
    }

    #[test]
    fn protected_names_are_never_deleted() {
        let sb = Sandbox::new("protected");
        let beacon = sb.file("Home/.gradle/caches/transforms/Beacon-app/out.bin", 40);
        let emr = sb.file("Local/npm-cache/emr-portal/x", 40);
        let other = sb.file("Local/npm-cache/other/x", 40);
        let r = sb.roots();
        assert_eq!(cat(&scan(&r, &settings()), "npm").bytes, 40);
        clean(&r, &settings(), &["npm".into(), "gradle".into()], &[]);
        assert!(beacon.exists() && emr.exists(), "case-insensitive match on any part of the path");
        assert!(!other.exists());
    }

    #[test]
    fn links_and_junctions_are_never_followed() {
        let sb = Sandbox::new("links");
        let outside = sb.file("Precious/keep.txt", 5);
        sb.file("Local/npm-cache/x", 1);
        let link = sb.0.join("Local").join("npm-cache").join("escape");
        // A directory symlink needs Developer Mode or admin; use a junction (no rights needed).
        // mklink wants backslash paths.
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(sb.0.join("Precious").to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(made.status.success(), "couldn't create a junction: {}", String::from_utf8_lossy(&made.stderr));
        assert!(std::fs::symlink_metadata(&link).map(|m| is_link(&m)).unwrap(), "the junction counts as a link");
        clean(&sb.roots(), &settings(), &["npm".into()], &[]);
        assert!(outside.exists(), "nothing behind the junction is touched");
    }

    fn make_avd(sb: &Sandbox, name: &str, image: &str, bytes: usize) {
        sb.file(&format!("Home/.android/avd/{name}.ini"), 10);
        sb.file(&format!("Home/.android/avd/{name}.avd/userdata.img"), bytes);
        let cfg = sb.0.join(format!("Home/.android/avd/{name}.avd/config.ini"));
        fs::write(cfg, format!("hw.ramSize=2048\nimage.sysdir.1=system-images\\{image}\\\n")).unwrap();
    }

    #[test]
    fn emulators_are_chosen_one_by_one_and_protected_ones_kept() {
        let sb = Sandbox::new("avd");
        make_avd(&sb, "Pixel_7_API_34", "android-34\\google_apis\\x86_64", 1000);
        make_avd(&sb, "Beacon_Tablet", "android-33\\google_apis\\x86_64", 500);
        sb.file("Local/Android/Sdk/system-images/android-34/google_apis/x86_64/system.img", 4000);
        sb.file("Local/Android/Sdk/system-images/android-33/google_apis/x86_64/system.img", 3000);
        let r = sb.roots();

        let report = scan(&r, &settings());
        let avds = &cat(&report, "avd").items;
        assert_eq!(avds.len(), 2);
        let beacon = avds.iter().find(|i| i.id == "avd:Beacon_Tablet").unwrap();
        assert!(beacon.protected);
        let images = &cat(&report, "sdk-images").items;
        let img33 = images.iter().find(|i| i.id == "image:android-33/google_apis/x86_64").unwrap();
        assert!(img33.protected, "used by the protected emulator");
        assert_eq!(img33.note.as_deref(), Some("Used by a protected emulator"));

        // Ask for everything, including the protected ones: they're still refused.
        let done = clean(
            &r,
            &settings(),
            &[],
            &[
                "avd:Pixel_7_API_34".into(),
                "avd:Beacon_Tablet".into(),
                "image:android-34/google_apis/x86_64".into(),
                "image:android-33/google_apis/x86_64".into(),
            ],
        );
        assert!(!sb.0.join("Home/.android/avd/Pixel_7_API_34.avd").exists());
        assert!(!sb.0.join("Home/.android/avd/Pixel_7_API_34.ini").exists());
        assert!(sb.0.join("Home/.android/avd/Beacon_Tablet.avd/userdata.img").exists());
        assert!(!sb.0.join("Local/Android/Sdk/system-images/android-34/google_apis/x86_64").exists());
        assert!(sb.0.join("Local/Android/Sdk/system-images/android-33/google_apis/x86_64/system.img").exists());
        assert!(done.freed_bytes >= 5000);
    }

    #[test]
    fn unknown_or_crafted_item_ids_do_nothing() {
        let sb = Sandbox::new("crafted");
        make_avd(&sb, "Pixel", "android-34\\google_apis\\x86_64", 10);
        let keep = sb.file("Home/Documents/thesis.docx", 10);
        let r = sb.roots();
        let done = clean(
            &r,
            &settings(),
            &["documents".into()],
            &["avd:..\\..\\Documents".into(), "image:../../../Home/Documents".into(), "avd:pixel ".into()],
        );
        assert_eq!(done.deleted_files, 0);
        assert!(keep.exists());
        assert!(sb.0.join("Home/.android/avd/Pixel.avd").exists());
    }

    #[test]
    fn inside_rejects_escapes() {
        let root = Path::new(r"C:\Sdk\system-images");
        assert!(inside(Path::new(r"C:\Sdk\system-images\android-34"), Some(root)));
        assert!(!inside(root, Some(root)));
        assert!(!inside(Path::new(r"C:\Sdk\system-images\..\..\Users"), Some(root)));
        assert!(!inside(Path::new(r"C:\Other"), Some(root)));
        assert!(!inside(Path::new(r"C:\Sdk\system-images\x"), None));
    }
}

#[cfg(test)]
mod real_pc {
    use super::*;

    /// Read-only: what Clean Windows would find on this PC (deletes nothing).
    /// Run with: cargo test scan_this_pc -- --ignored --nocapture
    #[test]
    #[ignore]
    fn scan_this_pc() {
        let started = std::time::Instant::now();
        let report = scan(&Roots::from_env(), &CleanSettings::default());
        for c in &report.categories {
            println!(
                "{:<28} {:>10.1} MB  {:>7} files  {}{}",
                c.title,
                c.bytes as f64 / 1e6,
                c.files,
                if c.available { "" } else { "(not found) " },
                if c.enabled { "" } else { "[off]" }
            );
            for i in &c.items {
                println!("    - {:<40} {:>8.1} MB {}", i.name, i.bytes as f64 / 1e6, if i.protected { "PROTECTED" } else { "" });
            }
        }
        if let Some(d) = report.disk {
            println!("disk: {:.1} GB free of {:.1} GB", d.free as f64 / 1e9, d.total as f64 / 1e9);
        }
        println!("scanned in {:?}", started.elapsed());
    }
}
