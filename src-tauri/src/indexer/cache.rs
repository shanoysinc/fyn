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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::AppKind;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fyn-cache-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = temp_dir("roundtrip");
        let apps = vec![App {
            id: r"lnk:c:\a.lnk".into(),
            name: "A".into(),
            kind: AppKind::Desktop,
            launch: r"C:\a.lnk".into(),
            target: Some(r"C:\a.exe".into()),
            icon: None,
            stamp: 42,
        }];
        save(&dir, &apps);
        let loaded = load(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, apps[0].id);
        assert_eq!(loaded[0].target, apps[0].target);
        assert_eq!(loaded[0].stamp, 42);
        assert!(!dir.join("apps.json.tmp").exists(), "temp file is renamed away");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_corrupt_cache_loads_empty() {
        let dir = temp_dir("corrupt");
        assert!(load(&dir).is_empty());
        std::fs::write(dir.join("apps.json"), b"{not json").unwrap();
        assert!(load(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
