//! Discovers launchable applications on the machine.
//!
//! Two sources are merged:
//! * Start Menu shortcuts (classic desktop apps, `.lnk` and non-web `.url`)
//! * The `shell:AppsFolder` virtual folder, restricted to packaged (Store/MSIX) apps

pub mod cache;
pub mod packaged;
pub mod shortcuts;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    /// Start Menu `.lnk` shortcut.
    Desktop,
    /// Packaged app launched through its AppUserModelID.
    Store,
    /// Start Menu `.url` shortcut with a non-web protocol (e.g. `steam://`).
    Link,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// Stable identifier used for pins and usage stats.
    pub id: String,
    pub name: String,
    pub kind: AppKind,
    /// What gets handed to ShellExecute: a shortcut path or `shell:AppsFolder\<AUMID>`.
    pub launch: String,
    /// Resolved executable for desktop apps (used for reveal + de-duplication).
    pub target: Option<String>,
    /// Absolute path of the cached PNG icon, once extracted.
    pub icon: Option<String>,
    /// Change marker (shortcut mtime) – part of the icon cache key.
    pub stamp: u64,
}

impl App {
    /// Path shown to the user / copied / revealed in Explorer.
    pub fn display_path(&self) -> &str {
        match self.kind {
            AppKind::Store => &self.launch,
            _ => self.target.as_deref().unwrap_or(&self.launch),
        }
    }
}

/// Full scan. Blocking; call from a background thread.
pub fn scan() -> Vec<App> {
    merge(shortcuts::scan(), packaged::scan())
}

/// Start Menu shortcuts win over packaged apps with the same (case-insensitive) name;
/// the result is sorted by name.
fn merge(mut apps: Vec<App>, packaged: Vec<App>) -> Vec<App> {
    let mut seen: HashSet<String> = apps.iter().map(|a| a.name.to_lowercase()).collect();
    for app in packaged {
        if seen.insert(app.name.to_lowercase()) {
            apps.push(app);
        }
    }
    apps.sort_by_cached_key(|a| a.name.to_lowercase());
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, kind: AppKind) -> App {
        App {
            id: format!("{kind:?}:{name}"),
            name: name.into(),
            kind,
            launch: format!("launch:{name}"),
            target: None,
            icon: None,
            stamp: 0,
        }
    }

    #[test]
    fn merge_prefers_shortcuts_and_dedupes_by_name() {
        let merged = merge(
            vec![app("Spotify", AppKind::Desktop)],
            vec![app("spotify", AppKind::Store), app("Calculator", AppKind::Store), app("Calculator", AppKind::Store)],
        );
        let names: Vec<_> = merged.iter().map(|a| (a.name.as_str(), a.kind)).collect();
        assert_eq!(names, [("Calculator", AppKind::Store), ("Spotify", AppKind::Desktop)]);
    }

    #[test]
    fn merge_sorts_case_insensitively() {
        let merged = merge(vec![app("zoom", AppKind::Desktop), app("Alacritty", AppKind::Desktop)], vec![app("Mail", AppKind::Store)]);
        let names: Vec<_> = merged.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Alacritty", "Mail", "zoom"]);
    }

    #[test]
    fn display_path_prefers_target_for_desktop_apps() {
        let mut a = app("A", AppKind::Desktop);
        assert_eq!(a.display_path(), "launch:A");
        a.target = Some(r"C:\a.exe".into());
        assert_eq!(a.display_path(), r"C:\a.exe");
        let mut s = app("S", AppKind::Store);
        s.target = Some("ignored".into());
        assert_eq!(s.display_path(), "launch:S");
    }

    #[test]
    fn app_kind_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&AppKind::Store).unwrap(), "\"store\"");
        assert_eq!(serde_json::to_string(&AppKind::Link).unwrap(), "\"link\"");
    }
}
