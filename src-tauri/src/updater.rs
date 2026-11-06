//! Auto-update through tauri-plugin-updater.
//!
//! Release builds check once, shortly after startup, and tell the UI when an update is
//! available. Installing only happens when the user asks for it.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg_attr(debug_assertions, allow(dead_code))]
pub const EVT_UPDATE_AVAILABLE: &str = "fyn://update-available";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    app.updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))
}

pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(find_update(app).await?.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download and run the installer, then restart into the new version.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let update = find_update(app).await?.ok_or("Fyn is already up to date")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Couldn't install the update: {e}"))?;
    app.restart();
}

/// Quietly look for an update shortly after startup (release builds only).
/// Errors are logged, never shown: being offline isn't worth a popup.
#[cfg(not(debug_assertions))]
pub fn check_in_background(app: &AppHandle) {
    use tauri::Emitter;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let delay = std::time::Duration::from_secs(15);
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay)).await;
        match check(&app).await {
            Ok(Some(info)) => {
                let _ = app.emit(EVT_UPDATE_AVAILABLE, info);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[fyn] {e}"),
        }
    });
}

#[cfg(debug_assertions)]
pub fn check_in_background(_app: &AppHandle) {}
