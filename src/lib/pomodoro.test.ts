import { describe, expect, it } from "vitest";
import { makePomodoro, POMO_SETTINGS } from "../test/fixtures";
import { formatClock, formatMinutes, nextPhase, phaseMinutes, remaining } from "./pomodoro";

describe("formatClock", () => {
  it("pads a countdown and rolls into hours", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(-20)).toBe("00:00");
    expect(formatClock(5 * 60_000)).toBe("05:00");
    expect(formatClock(25 * 60_000)).toBe("25:00");
    expect(formatClock(65 * 60_000)).toBe("1:05:00");
    expect(formatClock(1500)).toBe("00:02");
  });
});

describe("formatMinutes", () => {
  it("uses hours only once an hour is full", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(40)).toBe("40m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(95)).toBe("1h 35m");
  });
});

describe("nextPhase", () => {
  it("takes a short break until the cycle is complete, then a long one", () => {
    expect(nextPhase(makePomodoro({ doneInCycle: 0 }))).toBe("shortBreak");
    expect(nextPhase(makePomodoro({ doneInCycle: 2 }))).toBe("shortBreak");
    expect(nextPhase(makePomodoro({ doneInCycle: 3 }))).toBe("longBreak");
  });

  it("returns to focus after either break", () => {
    expect(nextPhase(makePomodoro({ phase: "shortBreak" }))).toBe("focus");
    expect(nextPhase(makePomodoro({ phase: "longBreak", doneInCycle: 4 }))).toBe("focus");
  });
});

describe("phaseMinutes", () => {
  it("reads the length of a phase from settings", () => {
    const view = makePomodoro();
    expect(phaseMinutes(view, "focus")).toBe(POMO_SETTINGS.focusMin);
    expect(phaseMinutes(view, "shortBreak")).toBe(5);
    expect(phaseMinutes(view, "longBreak")).toBe(15);
  });
});

describe("remaining", () => {
  it("counts down from the end time while running, and holds still while paused", () => {
    const running = makePomodoro({ running: true, endsAt: 10_000, remainingMs: 1 });
    expect(remaining(running, 4_000)).toBe(6_000);
    expect(remaining(running, 20_000)).toBe(0);
    const paused = makePomodoro({ running: false, endsAt: 10_000, remainingMs: 1234 });
    expect(remaining(paused, 99_000)).toBe(1234);
  });
});
