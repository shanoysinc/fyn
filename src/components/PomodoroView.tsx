import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, events, on, type PomodoroSettings, type PomodoroStats, type PomodoroView as State } from "../lib/ipc";
import { formatClock, formatMinutes, nextPhase, PHASE_LABEL, phaseMinutes, remaining, usePomodoro } from "../lib/pomodoro";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

type Tab = "timer" | "stats" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "timer", label: "Timer" },
  { id: "stats", label: "Stats" },
  { id: "settings", label: "Settings" },
];

export function PomodoroView({ onBack }: { onBack: () => void }) {
  const { view, setView, now } = usePomodoro();
  const [tab, setTab] = useState<Tab>("timer");
  const [label, setLabel] = useState<string | null>(null);
  const [stats, setStats] = useState<PomodoroStats | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const showError = useCallback((e: unknown) => setToast({ text: errorMessage(e), error: true }), []);

  const loadStats = useCallback(() => api.pomodoroStats().then(setStats).catch(showError), [showError]);

  // Stats change whenever a session ends (the timer emits on every change).
  useEffect(() => {
    void loadStats();
    return on(events.pomodoro, () => void loadStats());
  }, [loadStats]);

  // Fill the label once, from the running session.
  useEffect(() => {
    if (view && label === null) setLabel(view.label ?? "");
  }, [view, label]);

  useEffect(() => rootRef.current?.focus(), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const act = useCallback(
    async (call: () => Promise<State>) => {
      try {
        setView(await call());
      } catch (e) {
        showError(e);
      }
    },
    [setView, showError],
  );

  const toggle = useCallback(() => {
    if (!view) return;
    const trimmed = label?.trim();
    void act(() => (view.running ? api.pomodoroPause() : api.pomodoroStart(trimmed ? trimmed : undefined)));
  }, [act, label, view]);

  const saveSettings = useCallback(
    (patch: Partial<PomodoroSettings>) => {
      if (!view) return;
      void act(() => api.setPomodoroSettings({ ...view.settings, ...patch }));
    },
    [act, view],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target instanceof HTMLInputElement && e.target.type !== "checkbox";
    if (e.key === "Escape") {
      e.preventDefault();
      if (typing) rootRef.current?.focus();
      else onBack();
    } else if (mod && /^[123]$/.test(e.key)) {
      e.preventDefault();
      setTab(TABS[Number(e.key) - 1].id);
    } else if (mod && e.key === "ArrowRight") {
      e.preventDefault();
      void act(api.pomodoroSkip);
    } else if (mod && e.key.toLowerCase() === "r") {
      e.preventDefault();
      void act(api.pomodoroReset);
    } else if (tab === "timer" && (e.key === "Enter" || (e.key === " " && !typing)) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      toggle();
    }
  };

  const phase = view?.phase ?? "focus";

  return (
    <div className={`subview pomo pomo--${phase} ${view?.running ? "pomo--running" : ""}`} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <ViewHeader onBack={onBack}>
        <h1 className="clip-intro__title">Pomodoro</h1>
        <span className="dev__spacer" />
        <div className="segmented segmented--compact" role="tablist" aria-label="Pomodoro">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              title={`${t.label} (Ctrl+${i + 1})`}
              className={`segmented__item ${tab === t.id ? "segmented__item--on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </ViewHeader>

      <div className="pomo__body" key={tab}>
        {!view ? (
          <div className="empty">Loading…</div>
        ) : tab === "timer" ? (
          <TimerTab
            view={view}
            now={now}
            stats={stats}
            label={label ?? ""}
            labelRef={labelRef}
            onLabel={setLabel}
            onToggle={toggle}
            onSkip={() => void act(api.pomodoroSkip)}
            onReset={() => void act(api.pomodoroReset)}
          />
        ) : tab === "stats" ? (
          <StatsTab stats={stats} />
        ) : (
          <SettingsTab
            settings={view.settings}
            onChange={saveSettings}
            onClear={async () => {
              try {
                await api.pomodoroClearHistory();
                await loadStats();
                setToast({ text: "History cleared" });
              } catch (e) {
                showError(e);
              }
            }}
          />
        )}
      </div>

      <footer className="footer">
        <div className="footer__left">
          {toast ? (
            <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>
          ) : (
            <span className="footer__hint pomo__hint">
              <Kbd keys={["Ctrl", "→"]} /> Skip · <Kbd keys={["Ctrl", "R"]} /> Reset
            </span>
          )}
        </div>
        <div className="footer__right">
          <button className="btn btn--primary pomo__go" disabled={!view} onClick={toggle}>
            {view?.running ? "Pause" : view?.active ? "Resume" : `Start ${PHASE_LABEL[phase]}`}
            <Kbd keys={["↵"]} />
          </button>
        </div>
      </footer>
    </div>
  );
}

// ---------- timer ----------

function TimerTab({
  view,
  now,
  stats,
  label,
  labelRef,
  onLabel,
  onToggle,
  onSkip,
  onReset,
}: {
  view: State;
  now: number;
  stats: PomodoroStats | null;
  label: string;
  labelRef: React.RefObject<HTMLInputElement | null>;
  onLabel: (l: string) => void;
  onToggle: () => void;
  onSkip: () => void;
  onReset: () => void;
}) {
  const left = remaining(view, now);
  const fraction = view.durationMs ? left / view.durationMs : 0;
  const next = nextPhase(view);
  const cycle = view.settings.longEvery;
  // Completing a focus bumps this before the break begins, so breaks already include it.
  const done = view.doneInCycle;

  return (
    <div className="pomo__timer">
      <div className="pomo__dial">
        <Ring fraction={fraction} />
        <div className="pomo__center">
          <span className="pomo__phase">
            <span className="pomo__phase-dot" />
            {PHASE_LABEL[view.phase]}
          </span>
          <span className="pomo__clock" data-testid="clock" aria-live="off">
            {formatClock(left)}
          </span>
          <span className="pomo__dots" aria-label={`${done} of ${cycle} sessions in this cycle`}>
            {Array.from({ length: cycle }, (_, i) => (
              <span
                key={i}
                className={`pomo__dot ${i < done ? "pomo__dot--done" : ""} ${i === done && view.phase === "focus" && view.active ? "pomo__dot--now" : ""}`}
              />
            ))}
          </span>
        </div>
      </div>

      <div className="pomo__side">
        <label className="pomo__label">
          <Glyph name="sparkle" size={14} />
          <input
            ref={labelRef}
            value={label}
            onChange={(e) => onLabel(e.target.value)}
            placeholder="What are you focusing on?"
            maxLength={120}
            spellCheck={false}
          />
        </label>

        <div className="pomo__controls">
          <button className="pomo__round" aria-label="Reset" title="Reset (Ctrl+R)" onClick={onReset}>
            <Glyph name="restart" size={17} />
          </button>
          <button className="pomo__play" aria-label={view.running ? "Pause" : "Start"} onClick={onToggle}>
            <Glyph name={view.running ? "pause" : "play"} size={24} />
          </button>
          <button className="pomo__round" aria-label="Skip" title="Skip to the next phase (Ctrl+→)" onClick={onSkip}>
            <Glyph name="skip" size={17} />
          </button>
        </div>

        <p className="pomo__next">
          Up next <strong>{PHASE_LABEL[next]}</strong> · {phaseMinutes(view, next)} min
          {view.phase === "focus" ? (view.settings.autoStartBreaks ? ", starts by itself" : "") : view.settings.autoStartFocus ? ", starts by itself" : ""}
        </p>

        <div className="pomo__today">
          <div>
            <strong>{formatMinutes(stats?.todayMinutes ?? 0)}</strong>
            <span>focused today</span>
          </div>
          <div>
            <strong>{stats?.todaySessions ?? 0}</strong>
            <span>sessions</span>
          </div>
          <div>
            <strong className="pomo__streak">
              <Glyph name="flame" size={14} />
              {stats?.streak ?? 0}
            </strong>
            <span>day streak</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const R = 92;
const C = 2 * Math.PI * R;

/** The countdown ring: drains clockwise from the top, with a knob at the end. */
function Ring({ fraction }: { fraction: number }) {
  const f = Math.min(1, Math.max(0, fraction));
  const angle = f * 2 * Math.PI - Math.PI / 2;
  return (
    <svg className="pomo__ring" viewBox="0 0 220 220" aria-hidden>
      <defs>
        <linearGradient id="pomo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--p1)" />
          <stop offset="100%" stopColor="var(--p2)" />
        </linearGradient>
      </defs>
      {Array.from({ length: 60 }, (_, i) => {
        const a = (i / 60) * 2 * Math.PI;
        const r1 = i % 5 === 0 ? 103 : 105;
        return (
          <line
            key={i}
            className={i % 5 === 0 ? "pomo__tick pomo__tick--major" : "pomo__tick"}
            x1={110 + r1 * Math.sin(a)}
            y1={110 - r1 * Math.cos(a)}
            x2={110 + 108 * Math.sin(a)}
            y2={110 - 108 * Math.cos(a)}
          />
        );
      })}
      <circle className="pomo__track" cx="110" cy="110" r={R} />
      <circle
        className="pomo__progress"
        cx="110"
        cy="110"
        r={R}
        stroke="url(#pomo-grad)"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - f)}
        transform="rotate(-90 110 110)"
      />
      {f > 0.004 && <circle className="pomo__knob" cx={110 + R * Math.cos(angle)} cy={110 + R * Math.sin(angle)} r="7" />}
    </svg>
  );
}

// ---------- stats ----------

const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function when(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const day =
    d.toDateString() === today.toDateString() ? "Today" : d.toDateString() === yesterday.toDateString() ? "Yesterday" : DATE.format(d);
  return `${day}, ${TIME.format(d)}`;
}

function StatsTab({ stats }: { stats: PomodoroStats | null }) {
  if (!stats) return <div className="empty">Loading…</div>;
  const weekMinutes = stats.week.reduce((n, d) => n + d.minutes, 0);
  const max = Math.max(...stats.week.map((d) => d.minutes), 25);

  if (stats.totalSessions === 0 && stats.recent.length === 0) {
    return (
      <div className="pomo__empty">
        <span className="pomo__empty-icon">
          <Glyph name="timer" size={22} />
        </span>
        <strong>No sessions yet</strong>
        <span>Finish a focus session and your history and streaks show up here.</span>
      </div>
    );
  }

  return (
    <div className="pomo__stats">
      <div className="stat-tiles">
        <Stat value={formatMinutes(stats.todayMinutes)} label="Today" sub={`${stats.todaySessions} session${stats.todaySessions === 1 ? "" : "s"}`} />
        <Stat
          value={
            <>
              <Glyph name="flame" size={16} /> {stats.streak}
            </>
          }
          label="Streak"
          sub={stats.streak === 1 ? "day" : "days in a row"}
          accent
        />
        <Stat value={formatMinutes(weekMinutes)} label="Last 7 days" sub={`best day ${formatMinutes(stats.bestDayMinutes)}`} />
        <Stat value={formatMinutes(stats.totalMinutes)} label="All time" sub={`${stats.totalSessions} sessions`} />
      </div>

      <div className="pomo__split">
        <section className="pomo__chart" aria-label="Focus minutes, last 7 days">
          <h2>Focus, last 7 days</h2>
          <div className="bars" role="list">
            {stats.week.map((d, i) => {
              const isToday = i === stats.week.length - 1;
              const day = DAY.format(new Date(d.start * 1000));
              return (
                <div key={d.start} className={`bar ${isToday ? "bar--today" : ""}`} role="listitem" aria-label={`${day}: ${d.minutes} minutes`}>
                  <span className="bar__tip">
                    <strong>{formatMinutes(d.minutes)}</strong> {d.sessions} session{d.sessions === 1 ? "" : "s"}
                  </span>
                  <span className="bar__col">
                    <span className="bar__fill" style={{ height: `${d.minutes ? Math.max(4, (d.minutes / max) * 100) : 0}%` }} />
                  </span>
                  <span className="bar__day">{isToday ? "Today" : day}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="pomo__recent">
          <h2>Recent</h2>
          <ul>
            {stats.recent.map((s) => (
              <li key={`${s.started}-${s.ended}`}>
                <span className={`pomo__check ${s.completed ? "pomo__check--done" : ""}`} title={s.completed ? "Completed" : "Stopped early"}>
                  {s.completed && <Glyph name="check" size={11} />}
                </span>
                <span className="pomo__recent-text">
                  <span className="pomo__recent-label">{s.label || "Focus session"}</span>
                  <span className="pomo__recent-when">{when(s.started)}</span>
                </span>
                <span className="pomo__recent-min">{formatMinutes(Math.round(s.focusSecs / 60))}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Stat({ value, label, sub, accent }: { value: React.ReactNode; label: string; sub: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "stat--accent" : ""}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      <span className="stat__sub">{sub}</span>
    </div>
  );
}

// ---------- settings ----------

function SettingsTab({
  settings,
  onChange,
  onClear,
}: {
  settings: PomodoroSettings;
  onChange: (patch: Partial<PomodoroSettings>) => void;
  onClear: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  return (
    <div className="pomo__settings">
      <div className="pomo__steppers">
        <Stepper label="Focus" unit="min" value={settings.focusMin} min={1} max={180} step={5} onChange={(focusMin) => onChange({ focusMin })} />
        <Stepper label="Short break" unit="min" value={settings.shortMin} min={1} max={60} onChange={(shortMin) => onChange({ shortMin })} />
        <Stepper label="Long break" unit="min" value={settings.longMin} min={1} max={90} step={5} onChange={(longMin) => onChange({ longMin })} />
        <Stepper label="Long break every" unit="sessions" value={settings.longEvery} min={2} max={12} onChange={(longEvery) => onChange({ longEvery })} />
      </div>
      <SwitchRow label="Start breaks automatically" on={settings.autoStartBreaks} onClick={() => onChange({ autoStartBreaks: !settings.autoStartBreaks })} />
      <SwitchRow label="Start the next focus automatically" on={settings.autoStartFocus} onClick={() => onChange({ autoStartFocus: !settings.autoStartFocus })} />
      <SwitchRow label="Notify me when a phase ends" on={settings.notify} onClick={() => onChange({ notify: !settings.notify })} />
      <div className="pomo__danger">
        <span>
          History and stats stay on this PC.
          <small>Clearing them can't be undone.</small>
        </span>
        <button
          className={`btn btn--small ${confirm ? "btn--danger-solid" : ""}`}
          onClick={() => {
            if (!confirm) setConfirm(true);
            else {
              setConfirm(false);
              void onClear();
            }
          }}
        >
          {confirm ? "Click again to clear" : "Clear history"}
        </button>
      </div>
    </div>
  );
}

function Stepper({
  label,
  unit,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  // Snap to the step on the way up/down (25 -> 30 -> 35, but 1 -> 5 too).
  const down = () => set(value % step ? value - (value % step) : value - step);
  const up = () => set(value % step ? value + step - (value % step) : value + step);
  return (
    <div className="stepper">
      <span className="stepper__label">{label}</span>
      <div className="stepper__control">
        <button aria-label={`Less ${label.toLowerCase()}`} onClick={down} disabled={value <= min}>
          −
        </button>
        <span className="stepper__value">
          <strong>{value}</strong>
          {unit}
        </span>
        <button aria-label={`More ${label.toLowerCase()}`} onClick={up} disabled={value >= max}>
          +
        </button>
      </div>
    </div>
  );
}

function SwitchRow({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div className="pomo__switch-row">
      <span>{label}</span>
      <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "switch--on" : ""}`} onClick={onClick}>
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

/** Footer pill on the home screen while a session is under way. */
export function PomodoroPill({ onOpen }: { onOpen: () => void }) {
  const { view, now } = usePomodoro(events.shown);
  if (!view?.active) return null;
  const left = remaining(view, now);
  return (
    <button
      className={`pill pomo-pill pomo-pill--${view.phase} ${view.running ? "" : "pomo-pill--paused"}`}
      onClick={onOpen}
      title={`${PHASE_LABEL[view.phase]}${view.running ? "" : " (paused)"}: open Pomodoro`}
    >
      <span className="pomo-pill__dot" />
      {view.running ? null : <Glyph name="pause" size={10} />}
      <span className="pomo-pill__time">{formatClock(left)}</span>
      <span className="pomo-pill__phase">{PHASE_LABEL[view.phase]}</span>
    </button>
  );
}
