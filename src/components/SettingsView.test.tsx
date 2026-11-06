import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSettings } from "../test/fixtures";
import { api, resetApi } from "../test/mockIpc";
import { SettingsView } from "./SettingsView";

vi.mock("../lib/ipc", async (orig) => (await import("../test/mockIpc")).mockIpcModule(await orig()));

beforeEach(() => {
  resetApi();
  document.documentElement.removeAttribute("data-theme");
});

async function setup(props: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const user = userEvent.setup();
  const p = { onBack: vi.fn(), onShowWelcome: vi.fn(), update: null, onUpdate: vi.fn(), ...props };
  render(<SettingsView {...p} />);
  await screen.findByText("3 apps indexed.", { exact: false });
  return { user, ...p };
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("SettingsView", () => {
  it("shows the current settings", async () => {
    await setup();
    expect(screen.getByText("Ctrl")).toBeInTheDocument();
    expect(screen.getByText("Space")).toBeInTheDocument();
    expect(radio("System")).toHaveAttribute("aria-checked", "true");
    expect(radio("Google")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Fyn 0.1.0")).toBeInTheDocument();
  });

  it("changes only Fyn's theme", async () => {
    const { user } = await setup();
    await user.click(radio("Dark"));
    expect(api.setTheme).toHaveBeenCalledWith("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(radio("Dark")).toHaveAttribute("aria-checked", "true");

    await user.click(radio("System"));
    expect(api.setTheme).toHaveBeenLastCalledWith("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("reverts the theme if saving fails", async () => {
    api.setTheme.mockRejectedValueOnce("Unknown theme");
    const { user } = await setup();
    await user.click(radio("Light"));
    await screen.findByText("Unknown theme");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(radio("System")).toHaveAttribute("aria-checked", "true");
  });

  it("switches favorites & suggestions between icons and a list", async () => {
    const { user } = await setup();
    expect(radio("List")).toHaveAttribute("aria-checked", "true"); // fixture default
    await user.click(radio("Icons"));
    expect(api.setHomeLayout).toHaveBeenCalledWith("grid");
    expect(radio("Icons")).toHaveAttribute("aria-checked", "true");
  });

  it("changes the search engine", async () => {
    const { user } = await setup();
    await user.click(radio("DuckDuckGo"));
    expect(api.setSearchEngine).toHaveBeenCalledWith("duckduckgo");
    expect(radio("DuckDuckGo")).toHaveAttribute("aria-checked", "true");
  });

  it("toggles launch at login", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("switch", { name: "Launch at login" }));
    expect(api.setAutostart).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch", { name: "Launch at login" })).toHaveAttribute("aria-checked", "true");
  });

  it("records a new shortcut, suspending the old one meanwhile", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Ctrl/ }));
    expect(api.suspendHotkey).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Press a shortcut/)).toBeInTheDocument();
    await user.keyboard("{Alt>}[Space]{/Alt}");
    expect(api.setHotkey).toHaveBeenCalledWith("Alt+Space");
    await screen.findByText("Fyn now opens with Alt + Space");
    await waitFor(() => expect(api.suspendHotkey).toHaveBeenLastCalledWith(false));
  });

  it("Esc cancels recording without leaving Settings", async () => {
    const { user, onBack } = await setup();
    await user.click(screen.getByRole("button", { name: /Ctrl/ }));
    await user.keyboard("{Escape}");
    expect(api.setHotkey).not.toHaveBeenCalled();
    expect(api.suspendHotkey).toHaveBeenLastCalledWith(false);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("shows why a shortcut was rejected", async () => {
    api.setHotkey.mockRejectedValueOnce("Shortcut is already in use");
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Ctrl/ }));
    await user.keyboard("{Control>}{Alt>}k{/Alt}{/Control}");
    await screen.findByText("Shortcut is already in use");
  });

  it("Esc goes back", async () => {
    const { user, onBack } = await setup();
    await user.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalled();
  });

  it("rescans apps", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Rescan" }));
    expect(api.rescan).toHaveBeenCalled();
    expect(screen.getByText("Rescanning applications…")).toBeInTheDocument();
  });

  it("checks for updates and reports when up to date", async () => {
    const { user, onUpdate } = await setup();
    await user.click(screen.getByRole("button", { name: "Check for Updates" }));
    await screen.findByText("You're on the latest version.");
    expect(onUpdate).toHaveBeenCalledWith(null);
  });

  it("reports a found update to the app", async () => {
    const found = { version: "0.2.0", currentVersion: "0.1.0", notes: null };
    api.checkForUpdate.mockResolvedValueOnce(found);
    const { user, onUpdate } = await setup();
    await user.click(screen.getByRole("button", { name: "Check for Updates" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(found));
  });

  it("installs an available update", async () => {
    const { user } = await setup({ update: { version: "0.2.0", currentVersion: "0.1.0", notes: null } });
    expect(screen.getByText("Fyn 0.2.0 is available (you have 0.1.0).")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install & Restart" }));
    expect(api.installUpdate).toHaveBeenCalled();
  });

  it("shows update errors", async () => {
    api.checkForUpdate.mockRejectedValueOnce("Couldn't check for updates: offline");
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Check for Updates" }));
    await screen.findByText("Couldn't check for updates: offline");
  });

  it("shows the hotkey error from startup", async () => {
    api.getSettings.mockResolvedValue(makeSettings({ hotkeyError: "Ctrl+Space is taken" }));
    render(<SettingsView onBack={vi.fn()} onShowWelcome={vi.fn()} update={null} onUpdate={vi.fn()} />);
    await screen.findByText("Ctrl+Space is taken");
  });

  it("can reopen the welcome tour", async () => {
    const { user, onShowWelcome } = await setup();
    await user.click(screen.getByRole("button", { name: "Show Welcome" }));
    expect(onShowWelcome).toHaveBeenCalled();
  });
});
