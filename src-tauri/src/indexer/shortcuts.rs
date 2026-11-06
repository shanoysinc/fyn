//! Start Menu shortcut discovery.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use walkdir::WalkDir;
use windows::core::{Interface, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

use super::{App, AppKind};
use crate::win::{wide, ComGuard};

/// Shortcut names that are almost never what the user wants to launch.
const NOISE: &[&str] = &[
    "uninstall",
    "uninstaller",
    "readme",
    "read me",
    "release notes",
    "documentation",
    "help",
    "license",
    "website",
    "web site",
    "support",
    "changelog",
];

/// Target extensions that are documents rather than programs.
const DOC_EXTS: &[&str] = &[
    "txt", "chm", "pdf", "htm", "html", "rtf", "ini", "log", "md", "url",
];

pub fn start_menu_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for (var, sub) in [
        ("ProgramData", r"Microsoft\Windows\Start Menu\Programs"),
        ("APPDATA", r"Microsoft\Windows\Start Menu\Programs"),
    ] {
        if let Ok(base) = std::env::var(var) {
            let dir = PathBuf::from(base).join(sub);
            if dir.is_dir() {
                dirs.push(dir);
            }
        }
    }
    dirs
}

pub fn scan() -> Vec<App> {
    let _com = ComGuard::new();
    let mut apps = Vec::new();
    let mut seen_names = HashSet::new();
    let mut seen_targets = HashSet::new();

    for dir in start_menu_dirs() {
        for entry in WalkDir::new(&dir)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            let ext = extension(path);
            let found = match ext.as_str() {
                "lnk" => from_lnk(path),
                "url" => from_url(path).map(|a| (a, None)),
                _ => None,
            };
            let Some((app, dedupe_key)) = found else { continue };

            if !seen_names.insert(app.name.to_lowercase()) {
                continue;
            }
            // Same executable + arguments under two names (e.g. per-user and machine copies).
            if let Some(key) = dedupe_key {
                if !seen_targets.insert(key.to_lowercase()) {
                    continue;
                }
            }
            apps.push(app);
        }
    }
    apps
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn display_name(path: &Path) -> Option<String> {
    let name = path.file_stem()?.to_str()?.trim().to_string();
    let lower = name.to_lowercase();
    if name.is_empty() || NOISE.iter().any(|n| lower.contains(n)) {
        return None;
    }
    Some(name)
}

fn mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Returns the app plus a de-duplication key (target + arguments) when the target is known.
fn from_lnk(path: &Path) -> Option<(App, Option<String>)> {
    let name = display_name(path)?;
    let (target, args) = resolve_lnk(path).unwrap_or_default();

    if !target.is_empty() {
        let t = target.to_lowercase();
        let ext = extension(Path::new(&t));
        if DOC_EXTS.contains(&ext.as_str()) || t.contains("unins") {
            return None;
        }
    }

    let launch = path.to_string_lossy().into_owned();
    let dedupe_key = (!target.is_empty()).then(|| format!("{target}|{args}"));
    let app = App {
        id: format!("lnk:{}", launch.to_lowercase()),
        name,
        kind: AppKind::Desktop,
        launch,
        target: (!target.is_empty()).then_some(target),
        icon: None,
        stamp: mtime(path),
    };
    Some((app, dedupe_key))
}

/// Only keep `.url` shortcuts that launch something local (steam://, epic://, …), not websites.
fn from_url(path: &Path) -> Option<App> {
    let name = display_name(path)?;
    let text = std::fs::read_to_string(path).ok()?;
    let url = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("URL=").map(str::trim))?
        .to_string();
    let lower = url.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file:") {
        return None;
    }
    let launch = path.to_string_lossy().into_owned();
    Some(App {
        id: format!("url:{}", launch.to_lowercase()),
        name,
        kind: AppKind::Link,
        launch,
        target: None,
        icon: None,
        stamp: mtime(path),
    })
}

/// Returns (target path, arguments). Empty target for "advertised" shortcuts (MSI/Office).
fn resolve_lnk(path: &Path) -> Option<(String, String)> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        let wpath = wide(&path.to_string_lossy());
        file.Load(PCWSTR(wpath.as_ptr()), STGM_READ).ok()?;

        let mut buf = [0u16; 1024];
        let target = link
            .GetPath(&mut buf, std::ptr::null_mut(), 0)
            .ok()
            .map(|_| from_wide(&buf))
            .unwrap_or_default();

        let mut abuf = [0u16; 1024];
        let args = link
            .GetArguments(&mut abuf)
            .ok()
            .map(|_| from_wide(&abuf))
            .unwrap_or_default();

        Some((target, args))
    }
}

fn from_wide(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}
