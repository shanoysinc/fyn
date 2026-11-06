//! Pomodoro: a focus timer that runs in Rust (so it keeps going while Fyn is hidden),
//! with a Windows notification at the end of each phase, a countdown in the tray, and a
//! history of focus sessions for stats.
//!
//! The timer is a small state machine driven by explicit timestamps (`now`, unix ms),
//! so every transition is unit-tested without waiting.

use serde::{Deserialize, Serialize};

const MINUTE_MS: i64 = 60_000;
/// Focus shorter than this isn't worth recording when interrupted.
const MIN_RECORDED_MS: i64 = MINUTE_MS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PomodoroSettings {
    pub focus_min: u32,
    pub short_min: u32,
    pub long_min: u32,
    /// A long break after this many focus sessions.
    pub long_every: u32,
    pub auto_start_breaks: bool,
    pub auto_start_focus: bool,
    pub notify: bool,
}

impl Default for PomodoroSettings {
    fn default() -> Self {
        Self { focus_min: 25, short_min: 5, long_min: 15, long_every: 4, auto_start_breaks: true, auto_start_focus: false, notify: true }
    }
}

impl PomodoroSettings {
    pub fn validated(self) -> Result<Self, String> {
        let ok = (1..=180).contains(&self.focus_min)
            && (1..=60).contains(&self.short_min)
            && (1..=120).contains(&self.long_min)
            && (2..=12).contains(&self.long_every);
        if ok {
            Ok(self)
        } else {
            Err("Durations must be 1–180 min focus, 1–60 short break, 1–120 long break, long break every 2–12".into())
        }
    }

    pub fn duration_ms(&self, phase: Phase) -> i64 {
        i64::from(match phase {
            Phase::Focus => self.focus_min,
            Phase::ShortBreak => self.short_min,
            Phase::LongBreak => self.long_min,
        }) * MINUTE_MS
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Focus,
    ShortBreak,
    LongBreak,
}

/// A focus session to store in the history.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Unix seconds.
    pub started: i64,
    pub ended: i64,
    pub focus_secs: i64,
    /// Ran to the end (vs skipped or reset part-way).
    pub completed: bool,
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Timer {
    pub phase: Phase,
    /// Running: when the phase ends (unix ms). Not running: None.
    pub ends_at: Option<i64>,
    /// Time left when not running (paused or not started).
    pub remaining_ms: i64,
    /// When the current focus phase was first started (unix ms).
    focus_started: Option<i64>,
    /// Focus time already banked before the current run (pauses).
    focused_ms: i64,
    /// When the current run started (unix ms).
    run_started: Option<i64>,
    /// Focus sessions finished in this cycle (for the long break).
    pub done_in_cycle: u32,
    pub label: Option<String>,
}

/// What a finished phase leads to: a session to store, and whether to notify.
#[derive(Debug, PartialEq)]
pub struct Finished {
    pub ended: Phase,
    pub next: Phase,
    pub session: Option<Session>,
}

impl Timer {
    pub fn new(settings: &PomodoroSettings) -> Self {
        Self {
            phase: Phase::Focus,
            ends_at: None,
            remaining_ms: settings.duration_ms(Phase::Focus),
            focus_started: None,
            focused_ms: 0,
            run_started: None,
            done_in_cycle: 0,
            label: None,
        }
    }

    pub fn running(&self) -> bool {
        self.ends_at.is_some()
    }

    /// Time left right now.
    pub fn left_ms(&self, now: i64) -> i64 {
        self.ends_at.map_or(self.remaining_ms, |end| (end - now).max(0))
    }

    pub fn start(&mut self, now: i64) {
        if self.running() {
            return;
        }
        self.ends_at = Some(now + self.remaining_ms);
        self.run_started = Some(now);
        if self.phase == Phase::Focus {
            self.focus_started.get_or_insert(now);
        }
    }

    pub fn pause(&mut self, now: i64) {
        let Some(end) = self.ends_at.take() else { return };
        self.remaining_ms = (end - now).max(0);
        self.bank_focus(now);
    }

    fn bank_focus(&mut self, now: i64) {
        if let Some(started) = self.run_started.take() {
            if self.phase == Phase::Focus {
                self.focused_ms += (now - started).max(0);
            }
        }
    }

    /// Call regularly; finishes the phase once its time is up.
    pub fn tick(&mut self, now: i64, settings: &PomodoroSettings) -> Option<Finished> {
        match self.ends_at {
            Some(end) if now >= end => Some(self.finish(end, true, settings)),
            _ => None,
        }
    }

    /// End the phase early and move on.
    pub fn skip(&mut self, now: i64, settings: &PomodoroSettings) -> Finished {
        self.finish(now, false, settings)
    }

    /// Stop and go back to the start of a fresh cycle. Returns an interrupted focus
    /// session if one is worth recording.
    pub fn reset(&mut self, now: i64, settings: &PomodoroSettings) -> Option<Session> {
        let session = self.focus_session(now, false, settings);
        let label = self.label.take();
        *self = Self::new(settings);
        self.label = label;
        session
    }

    fn focus_session(&mut self, now: i64, completed: bool, settings: &PomodoroSettings) -> Option<Session> {
        if self.phase != Phase::Focus {
            return None;
        }
        if self.ends_at.is_some() {
            self.bank_focus(now);
        }
        let focused = if completed { settings.duration_ms(Phase::Focus) } else { self.focused_ms };
        let started = self.focus_started?;
        (completed || focused >= MIN_RECORDED_MS).then(|| Session {
            started: started / 1000,
            ended: now / 1000,
            focus_secs: focused / 1000,
            completed,
            label: self.label.clone(),
        })
    }

    fn finish(&mut self, now: i64, completed: bool, settings: &PomodoroSettings) -> Finished {
        let ended = self.phase;
        let session = self.focus_session(now, completed, settings);
        let next = match ended {
            Phase::Focus => {
                if completed {
                    self.done_in_cycle += 1;
                }
                if completed && self.done_in_cycle % settings.long_every == 0 {
                    Phase::LongBreak
                } else {
                    Phase::ShortBreak
                }
            }
            Phase::ShortBreak => Phase::Focus,
            Phase::LongBreak => {
                self.done_in_cycle = 0;
                Phase::Focus
            }
        };
        self.phase = next;
        self.ends_at = None;
        self.run_started = None;
        self.focus_started = None;
        self.focused_ms = 0;
        self.remaining_ms = settings.duration_ms(next);
        let auto = match next {
            Phase::Focus => settings.auto_start_focus,
            _ => settings.auto_start_breaks,
        };
        if auto {
            self.start(now);
        }
        Finished { ended, next, session }
    }
}

/// Notification text for a finished phase.
pub fn notification(f: &Finished, settings: &PomodoroSettings) -> (String, String) {
    match (f.ended, f.next) {
        (Phase::Focus, Phase::LongBreak) => (
            "Great work: time for a long break".into(),
            format!("{} focus sessions done. Take {} minutes.", settings.long_every, settings.long_min),
        ),
        (Phase::Focus, _) => ("Focus session done".into(), format!("Take a {}-minute break.", settings.short_min)),
        _ => ("Break's over".into(), format!("Ready for {} minutes of focus?", settings.focus_min)),
    }
}

/// "Focus · 12:34 left" for the tray tooltip.
pub fn tooltip(timer: &Timer, now: i64) -> String {
    let left = (timer.left_ms(now) + 999) / 1000;
    let what = match timer.phase {
        Phase::Focus => "Focus",
        Phase::ShortBreak => "Short break",
        Phase::LongBreak => "Long break",
    };
    let state = if timer.running() { "left" } else { "paused" };
    format!("{what} · {}:{:02} {state}", left / 60, left % 60)
}

// ---------- stats ----------

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// Local midnight, unix seconds.
    pub start: i64,
    pub minutes: i64,
    pub sessions: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub today_minutes: i64,
    pub today_sessions: i64,
    /// The last 7 days, oldest first, ending today.
    pub week: Vec<Day>,
    /// Days in a row with at least one completed session (today counts if done).
    pub streak: i64,
    pub total_minutes: i64,
    pub total_sessions: i64,
    pub best_day_minutes: i64,
    /// Newest first.
    pub recent: Vec<Session>,
}

/// `tz_offset_min`: minutes east of UTC (UTC+2 = 120), for local-day boundaries.
pub fn stats(sessions: &[Session], now_secs: i64, tz_offset_min: i32) -> Stats {
    let offset = i64::from(tz_offset_min) * 60;
    let day_of = |ts: i64| (ts + offset).div_euclid(86_400);
    let today = day_of(now_secs);

    let mut per_day = std::collections::BTreeMap::<i64, (i64, i64)>::new(); // day -> (secs, completed)
    for s in sessions {
        let e = per_day.entry(day_of(s.started)).or_default();
        e.0 += s.focus_secs;
        e.1 += i64::from(s.completed);
    }
    let get = |d: i64| per_day.get(&d).copied().unwrap_or_default();

    let week = (today - 6..=today)
        .map(|d| {
            let (secs, n) = get(d);
            Day { start: d * 86_400 - offset, minutes: secs / 60, sessions: n }
        })
        .collect();

    // Streak: count back from today (or from yesterday, if nothing yet today).
    let mut day = if get(today).1 > 0 { today } else { today - 1 };
    let mut streak = 0;
    while get(day).1 > 0 {
        streak += 1;
        day -= 1;
    }

    let mut recent = sessions.to_vec();
    recent.sort_by(|a, b| b.started.cmp(&a.started));
    recent.truncate(20);

    Stats {
        today_minutes: get(today).0 / 60,
        today_sessions: get(today).1,
        week,
        streak,
        total_minutes: sessions.iter().map(|s| s.focus_secs).sum::<i64>() / 60,
        total_sessions: sessions.iter().filter(|s| s.completed).count() as i64,
        best_day_minutes: per_day.values().map(|v| v.0 / 60).max().unwrap_or(0),
        recent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = MINUTE_MS;

    fn s() -> PomodoroSettings {
        PomodoroSettings::default()
    }

    #[test]
    fn a_focus_session_runs_to_a_break_and_is_recorded() {
        let mut t = Timer::new(&s());
        assert_eq!(t.left_ms(0), 25 * MIN);
        t.label = Some("Write report".into());
        t.start(1_000_000);
        assert!(t.running());
        assert_eq!(t.left_ms(1_000_000 + 10 * MIN), 15 * MIN);
        assert_eq!(t.tick(1_000_000 + 24 * MIN, &s()), None, "not yet");

        let done = t.tick(1_000_000 + 25 * MIN, &s()).unwrap();
        assert_eq!((done.ended, done.next), (Phase::Focus, Phase::ShortBreak));
        let session = done.session.unwrap();
        assert!(session.completed);
        assert_eq!(session.focus_secs, 25 * 60);
        assert_eq!(session.label.as_deref(), Some("Write report"));
        // Breaks start on their own by default.
        assert_eq!(t.phase, Phase::ShortBreak);
        assert!(t.running());
        assert_eq!(t.done_in_cycle, 1);
    }

    #[test]
    fn pausing_keeps_the_remaining_time_and_only_counts_focused_time() {
        let mut t = Timer::new(&s());
        t.start(0);
        t.pause(10 * MIN);
        assert!(!t.running());
        assert_eq!(t.left_ms(99 * MIN), 15 * MIN, "paused time doesn't count down");
        t.start(50 * MIN);
        let skipped = t.skip(55 * MIN, &s());
        let session = skipped.session.unwrap();
        assert!(!session.completed);
        assert_eq!(session.focus_secs, 15 * 60, "10 + 5 minutes, not the 45-minute pause");
        assert_eq!(t.done_in_cycle, 0, "a skipped focus doesn't count towards the long break");
    }

    #[test]
    fn every_fourth_focus_earns_a_long_break_then_the_cycle_restarts() {
        let settings = PomodoroSettings { auto_start_breaks: false, ..s() };
        let mut t = Timer::new(&settings);
        let mut now = 0;
        let mut nexts = vec![];
        for _ in 0..4 {
            t.start(now);
            now += 25 * MIN;
            nexts.push(t.tick(now, &settings).unwrap().next);
            t.start(now);
            now += 15 * MIN;
            t.tick(now, &settings);
        }
        assert_eq!(nexts, vec![Phase::ShortBreak, Phase::ShortBreak, Phase::ShortBreak, Phase::LongBreak]);
        assert_eq!(t.phase, Phase::Focus);
        assert_eq!(t.done_in_cycle, 0);
    }

    #[test]
    fn focus_does_not_auto_start_after_a_break_by_default() {
        let mut t = Timer::new(&s());
        t.start(0);
        t.tick(25 * MIN, &s()); // -> break, auto-started
        let done = t.tick(30 * MIN, &s()).unwrap();
        assert_eq!(done.next, Phase::Focus);
        assert!(!t.running(), "waits for you to start focusing");
        assert_eq!(t.left_ms(31 * MIN), 25 * MIN);
    }

    #[test]
    fn short_interruptions_are_not_recorded_but_longer_ones_are() {
        let mut t = Timer::new(&s());
        t.start(0);
        assert_eq!(t.reset(30_000, &s()), None, "30 seconds isn't a session");
        t.start(0);
        let session = t.reset(12 * MIN, &s()).unwrap();
        assert!(!session.completed);
        assert_eq!(session.focus_secs, 12 * 60);
        assert_eq!(t, {
            let mut fresh = Timer::new(&s());
            fresh.label = None;
            fresh
        });
    }

    #[test]
    fn skipping_a_break_goes_to_focus_without_a_session() {
        let mut t = Timer::new(&s());
        t.start(0);
        t.tick(25 * MIN, &s());
        let skipped = t.skip(26 * MIN, &s());
        assert_eq!((skipped.ended, skipped.next, skipped.session), (Phase::ShortBreak, Phase::Focus, None));
    }

    #[test]
    fn settings_are_validated() {
        assert!(PomodoroSettings { focus_min: 0, ..s() }.validated().is_err());
        assert!(PomodoroSettings { long_every: 1, ..s() }.validated().is_err());
        assert!(PomodoroSettings { focus_min: 50, short_min: 10, ..s() }.validated().is_ok());
    }

    #[test]
    fn notifications_and_tooltip_text() {
        let f = |ended, next| Finished { ended, next, session: None };
        assert_eq!(notification(&f(Phase::Focus, Phase::ShortBreak), &s()).0, "Focus session done");
        assert_eq!(notification(&f(Phase::Focus, Phase::LongBreak), &s()).1, "4 focus sessions done. Take 15 minutes.");
        assert_eq!(notification(&f(Phase::ShortBreak, Phase::Focus), &s()).0, "Break's over");

        let mut t = Timer::new(&s());
        assert_eq!(tooltip(&t, 0), "Focus · 25:00 paused");
        t.start(0);
        assert_eq!(tooltip(&t, 90_500), "Focus · 23:30 left");
    }

    fn session(started: i64, mins: i64, completed: bool) -> Session {
        Session { started, ended: started + mins * 60, focus_secs: mins * 60, completed, label: None }
    }

    #[test]
    fn stats_by_local_day_with_streak_and_totals() {
        let day = 86_400;
        // "Now" is 10:00 on day 100 in UTC+2 (offset 120 min).
        let offset = 120;
        let now = 100 * day + 8 * 3600;
        let sessions = vec![
            session(now - 3600, 25, true),          // today
            session(now - 2 * 3600, 25, true),      // today
            session(now - 3 * 3600, 10, false),     // today, interrupted
            session(now - day, 50, true),           // yesterday
            session(now - 2 * day, 25, true),       // 2 days ago
            session(now - 4 * day, 25, true),       // gap at 3 days ago
            session(100 * day - 30 * 60, 25, true), // 23:30 UTC = 01:30 local: counts as today
        ];
        let st = stats(&sessions, now, offset);
        assert_eq!(st.today_minutes, 25 + 25 + 10 + 25);
        assert_eq!(st.today_sessions, 3);
        assert_eq!(st.streak, 3, "today, yesterday, 2 days ago; then a gap");
        assert_eq!(st.week.len(), 7);
        assert_eq!(st.week[6].minutes, 85);
        assert_eq!(st.week[5].minutes, 50);
        assert_eq!(st.week[3].minutes, 0);
        assert_eq!(st.week[6].start, 100 * day - 2 * 3600, "local midnight");
        assert_eq!(st.total_sessions, 6);
        assert_eq!(st.total_minutes, 185);
        assert_eq!(st.best_day_minutes, 85);
        assert_eq!(st.recent.first().unwrap().started, now - 3600, "newest first");
    }

    #[test]
    fn streak_still_counts_when_today_has_nothing_yet() {
        let day = 86_400;
        let now = 50 * day + 9 * 3600;
        let st = stats(&[session(now - day, 25, true), session(now - 2 * day, 25, true)], now, 0);
        assert_eq!(st.streak, 2);
        assert_eq!(stats(&[session(now - 3 * day, 25, true)], now, 0).streak, 0);
    }
}
