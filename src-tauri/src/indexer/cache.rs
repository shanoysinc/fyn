//! On-disk snapshot of the last scan so the launcher is usable instantly at startup.

use std::path::Path;

use super::App;

const FILE: &str = "apps.json";

pub fn load(dir: &Path) -> Vec<App> {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Write atomically (temp file + rename) so a crash never leaves a corrupt cache.
pub fn save(dir: &Path, apps: &[App]) {
    let Ok(json) = serde_json::to_vec(apps) else { return };
    let tmp = dir.join(format!("{FILE}.tmp"));
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join(FILE));
    }
}
