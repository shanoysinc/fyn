//! Built-in system commands, Windows Settings pages, and opening URLs / files / folders.
//!
//! Like the rest of the IPC surface, nothing here runs arbitrary input: system commands
//! are a fixed list, Settings links and URLs are validated, and paths must exist on disk.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Registry::{
    RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD,
};
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::UI::Shell::{
    SHEmptyRecycleBinW, SHQueryRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI,
    SHERB_NOSOUND, SHQUERYRBINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};

use crate::launcher::{reveal_path, shell_open};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_URL_LEN: usize = 2048;
const MAX_PATH_LEN: usize = 1024;
const MAX_SETTINGS_PAGE_LEN: usize = 64;

#[derive(Clone, Copy)]
pub enum SystemCommand {
    Lock,
    Sleep,
    Restart,
    ShutDown,
    SignOut,
    EmptyRecycleBin,
    ToggleDarkMode,
}

impl SystemCommand {
    pub fn parse(id: &str) -> Option<Self> {
        Some(match id {
            "lock" => Self::Lock,
            "sleep" => Self::Sleep,
            "restart" => Self::Restart,
            "shutdown" => Self::ShutDown,
            "signout" => Self::SignOut,
            "empty-recycle-bin" => Self::EmptyRecycleBin,
            "toggle-dark-mode" => Self::ToggleDarkMode,
            _ => return None,
        })
    }

    /// Commands that end or interrupt the session hide the launcher first.
    pub fn hides_window(self) -> bool {
        !matches!(self, Self::EmptyRecycleBin | Self::ToggleDarkMode)
    }
}

/// Run a system command. Returns a message for the user, if there is one.
pub fn run(cmd: SystemCommand) -> Result<Option<String>, String> {
    match cmd {
        SystemCommand::Lock => unsafe { LockWorkStation() }
            .map(|_| None)
            .map_err(|e| format!("Couldn't lock the PC: {e}")),
        SystemCommand::Sleep => {
            // Give the launcher a moment to hide before the machine suspends.
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(400));
                let _ = unsafe { SetSuspendState(false, false, false) };
            });
            Ok(None)
        }
        SystemCommand::Restart => shutdown_exe(&["/r", "/t", "0"]),
        SystemCommand::ShutDown => shutdown_exe(&["/s", "/hybrid", "/t", "0"]),
        SystemCommand::SignOut => shutdown_exe(&["/l"]),
        SystemCommand::EmptyRecycleBin => empty_recycle_bin(),
        SystemCommand::ToggleDarkMode => toggle_dark_mode(),
    }
}

fn shutdown_exe(args: &[&str]) -> Result<Option<String>, String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    std::process::Command::new(format!(r"{root}\System32\shutdown.exe"))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| None)
        .map_err(|e| format!("Couldn't run shutdown: {e}"))
}

/// Items and bytes in the Recycle Bin (all drives).
pub fn recycle_bin_size() -> Result<(u64, u64), String> {
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.map_err(|e| e.to_string())?;
    Ok((info.i64NumItems.max(0) as u64, info.i64Size.max(0) as u64))
}

pub fn empty_recycle_bin() -> Result<Option<String>, String> {
    let (count, _) = recycle_bin_size()?;
    if count == 0 {
        return Ok(Some("Recycle Bin is already empty".into()));
    }
    unsafe {
        SHEmptyRecycleBinW(
            None,
            PCWSTR::null(),
            SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
        )
    }
    .map_err(|e| format!("Couldn't empty the Recycle Bin: {e}"))?;
    let s = if count == 1 { "" } else { "s" };
    Ok(Some(format!("Emptied Recycle Bin ({count} item{s})")))
}

const PERSONALIZE: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");

fn read_theme_value(name: PCWSTR) -> Option<u32> {
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PERSONALIZE,
            name,
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    status.ok().ok().map(|_| value)
}

fn write_theme_value(name: PCWSTR, value: u32) -> Result<(), String> {
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            PERSONALIZE,
            name,
            REG_DWORD.0,
            Some(&value as *const u32 as *const _),
            std::mem::size_of::<u32>() as u32,
        )
    }
    .ok()
    .map_err(|e| format!("Couldn't change the theme: {e}"))
}

/// Whether Windows is in dark mode (judged by the app theme, which is what most windows follow).
fn is_dark_mode() -> bool {
    read_theme_value(w!("AppsUseLightTheme")).unwrap_or(1) == 0
}

/// Switch both the app and the system (taskbar, Start) theme.
fn set_dark_mode(dark: bool) -> Result<(), String> {
    let light = u32::from(!dark);
    write_theme_value(w!("AppsUseLightTheme"), light)?;
    write_theme_value(w!("SystemUsesLightTheme"), light)?;
    // Tell running apps (Explorer, the taskbar, …) to pick up the new theme.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(w!("ImmersiveColorSet").as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            200,
            None,
        );
    }
    Ok(())
}

fn toggle_dark_mode() -> Result<Option<String>, String> {
    let dark = !is_dark_mode();
    set_dark_mode(dark)?;
    let mode = if dark { "dark" } else { "light" };
    Ok(Some(format!("Switched Windows to {mode} mode")))
}

/// Open a Windows Settings page (`ms-settings:display`, …).
pub fn open_settings_page(uri: &str) -> Result<(), String> {
    let valid = uri.strip_prefix("ms-settings:").is_some_and(|page| {
        page.len() <= MAX_SETTINGS_PAGE_LEN
            && page.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    });
    if !valid {
        return Err("Invalid Settings page".into());
    }
    shell_open(uri)
}

/// Open an http(s) URL in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
    validate_url(url)?;
    shell_open(url)
}

/// An http(s) URL with no spaces, quotes or control characters, within the length limit.
pub fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let valid = url.len() <= MAX_URL_LEN
        && (lower.starts_with("https://") || lower.starts_with("http://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"');
    if valid {
        Ok(())
    } else {
        Err("Invalid URL".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    path: String,
    is_dir: bool,
}

/// Resolve what the user typed (`C:\Users`, `~\Downloads`, `%APPDATA%`) to an existing
/// absolute path.
pub fn resolve_path(input: &str) -> Option<PathBuf> {
    let input = input.trim().trim_matches('"');
    if input.is_empty() || input.len() > MAX_PATH_LEN {
        return None;
    }
    let path = PathBuf::from(expand(input)?);
    (path.is_absolute() && path.exists()).then_some(path)
}

pub fn check_path(input: &str) -> Option<PathInfo> {
    let path = resolve_path(input)?;
    Some(PathInfo { is_dir: path.is_dir(), path: path.to_string_lossy().into_owned() })
}

pub fn open_path(input: &str, reveal: bool) -> Result<(), String> {
    let path = resolve_path(input).ok_or("That file or folder doesn't exist")?;
    let path = path.to_string_lossy();
    if reveal {
        reveal_path(&path)
    } else {
        shell_open(&path)
    }
}

/// Expand a leading `~` and `%VAR%` references. Unknown variables fail the whole path.
fn expand(input: &str) -> Option<String> {
    let input = match input.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['\\', '/']) => {
            format!("{}{rest}", std::env::var("USERPROFILE").ok()?)
        }
        _ => input.to_string(),
    };
    let mut out = String::with_capacity(input.len());
    let mut rest = input.as_str();
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        let name = &after[..end];
        if name.is_empty() {
            return None;
        }
        out.push_str(&std::env::var(name).ok()?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_pages_are_validated() {
        assert!(open_settings_page("ms-settings:display\" & calc").is_err());
        assert!(open_settings_page("https://example.com").is_err());
        assert!(open_settings_page("ms-settings:DISPLAY").is_err());
    }

    #[test]
    fn urls_are_validated() {
        assert!(open_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(open_url("javascript:alert(1)").is_err());
        assert!(open_url("https://exa mple.com").is_err());
    }

    #[test]
    fn expands_home_and_env_vars() {
        let home = std::env::var("USERPROFILE").unwrap();
        assert_eq!(expand("~").unwrap(), home);
        assert_eq!(expand(r"~\Downloads").unwrap(), format!(r"{home}\Downloads"));
        assert_eq!(expand(r"%USERPROFILE%\x").unwrap(), format!(r"{home}\x"));
        assert_eq!(expand("~foo").unwrap(), "~foo");
        assert!(expand("%FYN_SURELY_UNSET_VAR%").is_none());
        assert!(expand("50% off").is_none());
    }

    #[test]
    fn parses_every_system_command() {
        for id in ["lock", "sleep", "restart", "shutdown", "signout", "empty-recycle-bin", "toggle-dark-mode"] {
            assert!(SystemCommand::parse(id).is_some(), "{id}");
        }
        for id in ["", "LOCK", "format-c", "shutdown "] {
            assert!(SystemCommand::parse(id).is_none(), "{id:?}");
        }
    }

    #[test]
    fn only_session_commands_hide_the_window() {
        let hides = |id| SystemCommand::parse(id).unwrap().hides_window();
        for id in ["lock", "sleep", "restart", "shutdown", "signout"] {
            assert!(hides(id), "{id}");
        }
        assert!(!hides("empty-recycle-bin"));
        assert!(!hides("toggle-dark-mode"));
    }

    #[test]
    fn settings_page_length_limit() {
        let page = |n: usize| format!("ms-settings:{}", "a".repeat(n));
        // Over the limit is rejected before anything is opened.
        assert!(open_settings_page(&page(MAX_SETTINGS_PAGE_LEN + 1)).is_err());
        assert!(open_settings_page("ms-settings:a b").is_err());
        assert!(open_settings_page("ms-settings:a/b").is_err());
    }

    #[test]
    fn url_length_and_scheme_limits() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert!(open_url(&long).is_err());
        assert!(open_url("ftp://example.com").is_err());
        assert!(open_url("https://example.com/\"x").is_err());
        assert!(open_url("https://example.com/\tx").is_err());
        assert!(open_url("").is_err());
    }

    #[test]
    fn expand_handles_multiple_and_adjacent_vars() {
        let home = std::env::var("USERPROFILE").unwrap();
        let root = std::env::var("SystemRoot").unwrap();
        assert_eq!(expand("%USERPROFILE%%SystemRoot%").unwrap(), format!("{home}{root}"));
        assert_eq!(expand("~/x").unwrap(), format!("{home}/x"));
        assert!(expand("%%").is_none(), "empty variable name");
        assert!(expand("%USERPROFILE").is_none(), "unterminated");
        assert_eq!(expand(r"C:\plain").unwrap(), r"C:\plain");
    }

    #[test]
    fn check_path_reports_dirs_and_files() {
        let dir = std::env::temp_dir().join(format!("fyn-path-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").unwrap();

        let d = check_path(dir.to_str().unwrap()).unwrap();
        assert!(d.is_dir);
        let f = check_path(&format!("\"{}\"", file.display())).unwrap(); // quotes are stripped
        assert!(!f.is_dir);
        assert!(check_path("").is_none());
        assert!(check_path(&"C:\\".repeat(MAX_PATH_LEN)).is_none());
        assert!(open_path(r"C:\definitely\not\here\fyn", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_only_existing_absolute_paths() {
        assert!(resolve_path("~").is_some());
        assert!(resolve_path("relative\\path").is_none());
        assert!(resolve_path(r"C:\definitely\not\here\fyn").is_none());
    }
}
