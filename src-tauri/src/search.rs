//! Fuzzy search + ranking.
//!
//! Score = fuzzy match quality (nucleo, the matcher behind Helix)
//!       + bonuses for exact / prefix matches
//!       + frecency (how often and how recently the app was launched)
//!       + a small pin bonus.

use std::collections::{HashMap, HashSet};

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::indexer::App;
use crate::store::Usage;

pub struct Hit {
    pub index: usize,
    pub score: f64,
    /// Matched character indices in the app name, for highlighting.
    pub matches: Vec<u32>,
}

pub fn new_matcher() -> Matcher {
    let mut config = Config::DEFAULT;
    config.prefer_prefix = true;
    Matcher::new(config)
}

pub fn frecency(usage: &Usage, now: i64) -> f64 {
    let days = (now - usage.last_used).max(0) as f64 / 86_400.0;
    let recency = if days < 1.0 {
        1.0
    } else if days < 7.0 {
        0.7
    } else if days < 30.0 {
        0.4
    } else {
        0.15
    };
    usage.count as f64 * recency
}

pub fn search(
    apps: &[App],
    query: &str,
    matcher: &mut Matcher,
    usage: &HashMap<String, Usage>,
    pins: &HashSet<String>,
    now: i64,
    limit: usize,
) -> Vec<Hit> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
    let q = query.to_lowercase();

    let mut buf = Vec::new();
    let mut indices = Vec::new();
    let mut hits = Vec::new();

    for (i, app) in apps.iter().enumerate() {
        indices.clear();
        let Some(score) = pattern.indices(Utf32Str::new(&app.name, &mut buf), matcher, &mut indices)
        else {
            continue;
        };

        let name = app.name.to_lowercase();
        let mut total = score as f64;
        if name == q {
            total += 120.0;
        } else if name.starts_with(&q) {
            total += 60.0;
        } else if name.split(|c: char| !c.is_alphanumeric()).any(|w| w.starts_with(&q)) {
            total += 25.0;
        }
        if let Some(u) = usage.get(&app.id) {
            total += frecency(u, now).min(25.0) * 4.0;
        }
        if pins.contains(&app.id) {
            total += 15.0;
        }

        indices.sort_unstable();
        indices.dedup();
        hits.push(Hit { index: i, score: total, matches: indices.clone() });
    }

    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| apps[a.index].name.len().cmp(&apps[b.index].name.len()))
    });
    hits.truncate(limit);
    hits
}
