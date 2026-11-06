//! Launching apps and revealing them in Explorer.

use std::os::windows::process::CommandExt;
use std::path::Path;

use windows::core::{w, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY, SW_SHOWNORMAL};

use crate::indexer::{App, AppKind};
use crate::win::wide;

pub fn launch(app: &App, as_admin: bool) -> Result<(), String> {
    if as_admin && app.kind == AppKind::Store {
        return Err("Store apps can't be run as administrator".into());
    }
    let verb = if as_admin { w!("runas") } else { w!("open") };
    let file = wide(&app.launch);
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
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("Couldn't open {} (code {})", app.name, result.0 as isize))
        }
    }
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
    // Paths come from the indexer, but never let one break out of the quoted argument.
    if target.contains('"') || !Path::new(target).is_absolute() {
        return Err("Invalid path".into());
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{target}\""))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
