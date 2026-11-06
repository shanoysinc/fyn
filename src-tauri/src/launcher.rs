//! Launching apps, URLs and paths, and revealing them in Explorer.

use std::os::windows::process::CommandExt;
use std::path::Path;

use windows::core::{w, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY, SW_SHOWNORMAL};

use crate::indexer::{App, AppKind};
use crate::win::wide;

/// ShellExecute `target` with `verb`. Returns the raw error code on failure.
fn shell_execute(verb: PCWSTR, target: &str) -> Result<(), isize> {
    let file = wide(target);
    unsafe {
        // Let the launched process take the foreground even though we're about to hide.
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let result = ShellExecuteW(
            None,
            verb,
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        // ShellExecute returns a value > 32 on success.
        let code = result.0 as isize;
        if code > 32 {
            Ok(())
        } else {
            Err(code)
        }
    }
}

pub fn launch(app: &App, as_admin: bool) -> Result<(), String> {
    if as_admin && app.kind == AppKind::Store {
        return Err("Store apps can't be run as administrator".into());
    }
    let verb = if as_admin { w!("runas") } else { w!("open") };
    shell_execute(verb, &app.launch).map_err(|code| format!("Couldn't open {} (code {code})", app.name))
}

/// Open a URL, ms-settings: link, file or folder with its default handler.
/// Callers must validate `target` first.
pub fn shell_open(target: &str) -> Result<(), String> {
    shell_execute(w!("open"), target).map_err(|code| format!("Couldn't open {target} (code {code})"))
}

pub fn reveal(app: &App) -> Result<(), String> {
    if app.kind == AppKind::Store {
        // Packaged apps live in a protected folder; open the Apps folder instead.
        std::process::Command::new("explorer.exe")
            .arg("shell:AppsFolder")
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let target = app
        .target
        .as_deref()
        .filter(|t| Path::new(t).exists())
        .unwrap_or(&app.launch);
    reveal_path(target)
}

/// Select `target` in a new Explorer window.
pub fn reveal_path(target: &str) -> Result<(), String> {
    // Never let a path break out of the quoted argument.
    if target.contains('"') || !Path::new(target).is_absolute() {
        return Err("Invalid path".into());
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{target}\""))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveal_rejects_relative_and_quoted_paths() {
        // Rejected before Explorer is ever started.
        assert!(reveal_path(r"relative\path").is_err());
        assert!(reveal_path(r#"C:\a" /evil"#).is_err());
    }

    #[test]
    fn store_apps_cannot_run_as_admin() {
        let app = App {
            id: "aumid:x".into(),
            name: "X".into(),
            kind: AppKind::Store,
            launch: r"shell:AppsFolder\X".into(),
            target: None,
            icon: None,
            stamp: 0,
        };
        assert!(launch(&app, true).is_err());
    }
}
