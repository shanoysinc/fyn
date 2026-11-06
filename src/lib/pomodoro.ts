import { useEffect, useState } from "react";
import { api, events, on, type PomodoroPhase, type PomodoroView } from "./ipc";

export const PHASE_LABEL: Record<PomodoroPhase, string> = {
  focus: "Focus",
  shortBreak: "Short break",
  longBreak: "Long break",
};

/** 1500000 -> "25:00"; an hour or more -> "1:05:00". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m).padStart(2, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** 95 -> "1h 35m", 40 -> "40m", 0 -> "0m". */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** What comes after the current phase (assuming it runs to the end). */
export function nextPhase(v: PomodoroView): PomodoroPhase {
  if (v.phase !== "focus") return "focus";
  return v.doneInCycle + 1 >= v.settings.longEvery ? "longBreak" : "shortBreak";
}

export function phaseMinutes(v: PomodoroView, phase: PomodoroPhase): number {
  const s = v.settings;
  return phase === "focus" ? s.focusMin : phase === "shortBreak" ? s.shortMin : s.longMin;
}

/** Time left right now: counts down by itself while running. */
export function remaining(v: PomodoroView, now = Date.now()): number {
  return v.running && v.endsAt !== null ? Math.max(0, v.endsAt - now) : v.remainingMs;
}

/**
 * The timer's state, kept in sync with the backend (which owns the clock and keeps
 * running while Fyn is hidden), plus `now`, ticking while it runs.
 */
export function usePomodoro(refreshOn?: string) {
  const [view, setView] = useState<PomodoroView | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let live = true;
    const load = () => api.pomodoroState().then((v) => live && setView(v)).catch(() => {});
    load();
    const offs = [on<PomodoroView>(events.pomodoro, (v) => live && setView(v))];
    if (refreshOn) offs.push(on(refreshOn, load));
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [refreshOn]);

  useEffect(() => {
    if (!view?.running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [view?.running]);

  return { view, setView, now };
}
