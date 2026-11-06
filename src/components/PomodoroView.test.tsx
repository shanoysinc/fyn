import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePomodoro, makePomodoroStats } from "../test/fixtures";
import { api, resetApi } from "../test/mockIpc";
import { PomodoroPill, PomodoroView } from "./PomodoroView";

vi.mock("../lib/ipc", async (orig) => (await import("../test/mockIpc")).mockIpcModule(await orig()));

beforeEach(() => resetApi());

describe("Pomodoro", () => {
  it("shows the countdown and starts a labelled focus session", async () => {
    const user = userEvent.setup();
    render(<PomodoroView onBack={vi.fn()} />);
    expect(await screen.findByTestId("clock")).toHaveTextContent("25:00");
    expect(screen.getByText("focused today")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("What are you focusing on?"), "Deep work");
    await user.click(screen.getByRole("button", { name: /Start Focus/ }));
    expect(api.pomodoroStart).toHaveBeenCalledWith("Deep work");
  });

  it("shows history, the week, and the streak", async () => {
    const user = userEvent.setup();
    render(<PomodoroView onBack={vi.fn()} />);
    await screen.findByTestId("clock");
    await user.click(screen.getByRole("tab", { name: "Stats" }));
    expect(await screen.findByText("Write the report")).toBeInTheDocument();
    expect(screen.getByText("days in a row")).toBeInTheDocument();
    expect(screen.getByText(/best day 2h 5m/)).toBeInTheDocument();
    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
  });

  it("explains an empty history", async () => {
    api.pomodoroStats.mockResolvedValue(
      makePomodoroStats({
        todayMinutes: 0,
        todaySessions: 0,
        week: makePomodoroStats().week.map((d) => ({ ...d, minutes: 0, sessions: 0 })),
        streak: 0,
        totalMinutes: 0,
        totalSessions: 0,
        bestDayMinutes: 0,
        recent: [],
      }),
    );
    const user = userEvent.setup();
    render(<PomodoroView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "Stats" }));
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("saves a longer focus and clears history on a second click", async () => {
    const user = userEvent.setup();
    render(<PomodoroView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "More focus" }));
    expect(api.setPomodoroSettings).toHaveBeenCalledWith(expect.objectContaining({ focusMin: 30 }));
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    await user.click(screen.getByRole("button", { name: "Click again to clear" }));
    await waitFor(() => expect(api.pomodoroClearHistory).toHaveBeenCalled());
  });
});

describe("PomodoroPill", () => {
  it("stays hidden until a session is under way, then opens the timer", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { unmount } = render(<PomodoroPill onOpen={onOpen} />);
    await waitFor(() => expect(api.pomodoroState).toHaveBeenCalled());
    expect(screen.queryByTitle(/open Pomodoro/)).not.toBeInTheDocument();
    unmount();

    api.pomodoroState.mockResolvedValue(
      makePomodoro({ active: true, running: true, endsAt: Date.now() + 25 * 60_000, remainingMs: 25 * 60_000 }),
    );
    render(<PomodoroPill onOpen={onOpen} />);
    const pill = await screen.findByTitle(/open Pomodoro/);
    expect(pill).toHaveTextContent(/2[45]:\d{2}/);
    expect(pill).toHaveTextContent("Focus");
    await user.click(pill);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
