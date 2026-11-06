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
    let mut apps = shortcuts::scan();
    let mut seen: HashSet<String> = apps.iter().map(|a| a.name.to_lowercase()).collect();
    for app in packaged::scan() {
        if seen.insert(app.name.to_lowercase()) {
            apps.push(app);
        }
    }
    apps.sort_by_cached_key(|a| a.name.to_lowercase());
    apps
}
