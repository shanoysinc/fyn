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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::AppKind;

    const NOW: i64 = 1_700_000_000;
    const DAY: i64 = 86_400;

    fn app(name: &str) -> App {
        App {
            id: format!("id:{name}"),
            name: name.into(),
            kind: AppKind::Desktop,
            launch: format!(r"C:\{name}.lnk"),
            target: None,
            icon: None,
            stamp: 0,
        }
    }

    fn run(apps: &[App], q: &str, usage: &HashMap<String, Usage>, pins: &HashSet<String>) -> Vec<String> {
        let mut m = new_matcher();
        search(apps, q, &mut m, usage, pins, NOW, 50)
            .into_iter()
            .map(|h| apps[h.index].name.clone())
            .collect()
    }

    fn names(apps: &[App], q: &str) -> Vec<String> {
        run(apps, q, &HashMap::new(), &HashSet::new())
    }

    #[test]
    fn empty_or_blank_query_returns_nothing() {
        let apps = vec![app("Chrome")];
        assert!(names(&apps, "").is_empty());
        assert!(names(&apps, "   ").is_empty());
    }

    #[test]
    fn non_matching_apps_are_excluded() {
        let apps = vec![app("Chrome"), app("Firefox")];
        assert_eq!(names(&apps, "chr"), ["Chrome"]);
        assert!(names(&apps, "zzz").is_empty());
    }

    #[test]
    fn exact_beats_prefix_beats_word_prefix() {
        let apps = vec![app("My Code Tool"), app("Code Insiders"), app("Code")];
        assert_eq!(names(&apps, "code"), ["Code", "Code Insiders", "My Code Tool"]);
    }

    #[test]
    fn matching_is_case_insensitive() {
        let apps = vec![app("Visual Studio Code")];
        assert_eq!(names(&apps, "VISUAL"), ["Visual Studio Code"]);
    }

    #[test]
    fn fuzzy_initials_match() {
        let apps = vec![app("Visual Studio Code"), app("Notepad")];
        assert_eq!(names(&apps, "vsc"), ["Visual Studio Code"]);
    }

    #[test]
    fn match_indices_point_at_the_hit_characters() {
        let apps = vec![app("Chrome")];
        let mut m = new_matcher();
        let hits = search(&apps, "chr", &mut m, &HashMap::new(), &HashSet::new(), NOW, 10);
        assert_eq!(hits[0].matches, vec![0, 1, 2]);
    }

    #[test]
    fn frequently_used_app_ranks_higher() {
        let apps = vec![app("Notepad"), app("Notepad++")];
        assert_eq!(names(&apps, "note")[0], "Notepad"); // shorter name wins the tie
        let usage = HashMap::from([("id:Notepad++".to_string(), Usage { count: 10, last_used: NOW })]);
        assert_eq!(run(&apps, "note", &usage, &HashSet::new())[0], "Notepad++");
    }

    #[test]
    fn pinned_app_gets_a_bonus() {
        let apps = vec![app("Notepad"), app("Notepad++")];
        let pins = HashSet::from(["id:Notepad++".to_string()]);
        assert_eq!(run(&apps, "note", &HashMap::new(), &pins)[0], "Notepad++");
    }

    #[test]
    fn ties_break_on_shorter_name() {
        let apps = vec![app("Paint 3D"), app("Paint")];
        assert_eq!(names(&apps, "pain")[0], "Paint");
    }

    #[test]
    fn limit_truncates_results() {
        let apps: Vec<App> = (0..20).map(|i| app(&format!("App {i}"))).collect();
        let mut m = new_matcher();
        let hits = search(&apps, "app", &mut m, &HashMap::new(), &HashSet::new(), NOW, 5);
        assert_eq!(hits.len(), 5);
    }

    #[test]
    fn frecency_decays_with_age() {
        let u = |days: i64| Usage { count: 10, last_used: NOW - days * DAY };
        assert_eq!(frecency(&u(0), NOW), 10.0);
        assert_eq!(frecency(&u(3), NOW), 7.0);
        assert_eq!(frecency(&u(10), NOW), 4.0);
        assert_eq!(frecency(&u(100), NOW), 1.5);
        // A timestamp in the future (clock change) counts as "just now", not negative.
        assert_eq!(frecency(&Usage { count: 2, last_used: NOW + DAY }, NOW), 2.0);
    }
}
