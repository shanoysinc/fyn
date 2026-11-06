import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { CHROME, CODE, makeHome, makeSettings } from "./test/fixtures";
import { api, clipboard, emit, installClipboard, resetApi } from "./test/mockIpc";

vi.mock("./lib/ipc", async (orig) => (await import("./test/mockIpc")).mockIpcModule(await orig()));

beforeEach(() => {
  resetApi();
  installClipboard();
  document.documentElement.removeAttribute("data-theme");
});

async function setup() {
  const user = userEvent.setup();
  installClipboard(); // after setup(): user-event replaces navigator.clipboard with its own stub
  render(<App />);
  const input = await screen.findByPlaceholderText(/Search apps/);
  await screen.findByText("Favorites");
  return { user, input };
}

const selectedRow = () => document.querySelector('.row[data-selected="true"]');
const toast = () => document.querySelector(".toast")?.textContent ?? null;

describe("home screen", () => {
  it("shows favorites, suggestions and all applications", async () => {
    await setup();
    expect(screen.getByText("Favorites")).toBeInTheDocument();
    expect(screen.getByText("Suggestions")).toBeInTheDocument();
    expect(screen.getByText("Applications")).toBeInTheDocument();
    expect(screen.getAllByText("Google Chrome")).toHaveLength(2); // favorite + applications
  });

  it("selects the first favorite and opens it with Enter", async () => {
    const { user } = await setup();
    expect(selectedRow()).toHaveTextContent("Google Chrome");
    await user.keyboard("{Enter}");
    expect(api.launch).toHaveBeenCalledWith(CHROME.id);
  });

  it("Ctrl+1 opens the first favorite", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>}1{/Control}");
    expect(api.launch).toHaveBeenCalledWith(CHROME.id);
  });

  it("shows an error toast when launching fails", async () => {
    api.launch.mockRejectedValueOnce("That app is no longer installed");
    const { user } = await setup();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(toast()).toBe("That app is no longer installed"));
  });
});

describe("searching", () => {
  it("orders quick results, apps, commands and web searches", async () => {
    api.search.mockResolvedValue([{ ...CODE, matches: [0] }]);
    const { user, input } = await setup();
    await user.type(input, "2+2");
    await screen.findByText("Top Result");
    const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent);
    expect(headings).toEqual(["Top Result", "Applications", "Use “2+2” with…"]);
    expect(selectedRow()).toHaveTextContent("4");
  });

  it("Enter on the calculator copies the answer", async () => {
    const { user, input } = await setup();
    await user.type(input, "24*1.15");
    await screen.findByText("27.6");
    await user.keyboard("{Enter}");
    expect(clipboard.writeText).toHaveBeenCalledWith("27.6");
    await waitFor(() => expect(toast()).toBe("Copied 27.6"));
  });

  it("puts strongly matching commands above loosely matching apps", async () => {
    api.search.mockResolvedValue([{ ...CODE, name: "Clock Studio" }]);
    const { user, input } = await setup();
    await user.type(input, "lock");
    await screen.findByText("Commands");
    expect(selectedRow()).toHaveTextContent("Lock Screen");
    await user.keyboard("{Enter}");
    expect(api.runSystemCommand).toHaveBeenCalledWith("lock");
  });

  it("keeps apps first when an app name starts with the query", async () => {
    api.search.mockResolvedValue([{ ...CODE, name: "Lockbox" }]);
    const { user, input } = await setup();
    await user.type(input, "lock");
    await screen.findByText("Commands");
    expect(selectedRow()).toHaveTextContent("Lockbox");
  });

  it("uses the configured search engine for the fallback", async () => {
    api.getSettings.mockResolvedValue(makeSettings({ searchEngine: "duckduckgo" }));
    const { user, input } = await setup();
    await user.type(input, "qqzz");
    await screen.findByText("Search DuckDuckGo for “qqzz”");
    await user.keyboard("{Enter}");
    expect(api.openUrl).toHaveBeenCalledWith("https://duckduckgo.com/?q=qqzz");
  });

  it("asks the backend about paths and offers to open them", async () => {
    api.checkPath.mockResolvedValue({ path: "C:\\Users", isDir: true });
    const { user, input } = await setup();
    await user.type(input, "C:\\Users");
    await screen.findByText("Folder");
    expect(api.checkPath).toHaveBeenLastCalledWith("C:\\Users");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(api.openPath).toHaveBeenCalledWith("C:\\Users", true);
  });

  it("does not ask about paths for ordinary text", async () => {
    const { user, input } = await setup();
    await user.type(input, "chrome");
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith("chrome"));
    expect(api.checkPath).not.toHaveBeenCalled();
  });

  it("drops stale search responses", async () => {
    let resolveFirst!: (v: unknown) => void;
    api.search
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValue([{ ...CODE, name: "Second Result" }]);
    const { user, input } = await setup();
    await user.type(input, "ab");
    await screen.findByText("Second Result");
    await act(async () => resolveFirst([{ ...CODE, id: "stale", name: "Stale Result" }]));
    expect(screen.queryByText("Stale Result")).not.toBeInTheDocument();
  });

  it("Ctrl+Enter on something without a reveal action does nothing", async () => {
    // Regression: it used to fall through to cmdk's Enter and run the primary action.
    const { user, input } = await setup();
    await user.type(input, "qqzz");
    await screen.findByText("Search Google for “qqzz”");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(api.openUrl).not.toHaveBeenCalled();
  });

  it("Esc clears the search, then hides the window", async () => {
    const { user, input } = await setup();
    await user.type(input, "abc");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(api.hide).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(api.hide).toHaveBeenCalled();
  });
});

describe("confirmation for risky commands", () => {
  it("needs a second Enter before restarting", async () => {
    const { user, input } = await setup();
    await user.type(input, "restart");
    await screen.findByText("Commands");
    await user.keyboard("{Enter}");
    expect(api.runSystemCommand).not.toHaveBeenCalled();
    expect(toast()).toBe("Press ↵ again to restart your PC");
    expect(screen.getByText(/Press ↵ to Confirm/)).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(api.runSystemCommand).toHaveBeenCalledWith("restart");
  });

  it("cancels the confirmation (and its prompt) when the selection moves", async () => {
    const { user, input } = await setup();
    await user.type(input, "restart");
    await screen.findByText("Commands");
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(toast()).toBeNull());
    await user.keyboard("{ArrowUp}{Enter}");
    expect(api.runSystemCommand).not.toHaveBeenCalled(); // asks again
  });

  it("expires the confirmation after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<App />);
      const input = await screen.findByPlaceholderText(/Search apps/);
      await user.type(input, "shut down");
      await screen.findByText("Commands");
      await user.keyboard("{Enter}");
      await act(async () => vi.advanceTimersByTime(4500));
      expect(toast()).toBeNull();
      await user.keyboard("{Enter}");
      expect(api.runSystemCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("favorites", () => {
  it("Ctrl+Shift+P toggles the selected app", async () => {
    api.search.mockResolvedValue([CODE]);
    const { user, input } = await setup();
    await user.type(input, "code");
    await screen.findByText("Visual Studio Code");
    await user.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    expect(api.togglePin).toHaveBeenCalledWith(CODE.id);
    await waitFor(() => expect(toast()).toBe("Added Visual Studio Code to Favorites"));
  });

  it("right-click opens the actions menu with Remove from Favorites", async () => {
    const { user } = await setup();
    const row = screen.getAllByText("Google Chrome")[0].closest(".row")!;
    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
    await waitFor(() => expect(document.querySelector(".actions")).toBeInTheDocument());
    const menu = document.querySelector<HTMLElement>(".actions")!;
    const remove = within(menu).getByText("Remove from Favorites");
    api.togglePin.mockResolvedValue(false);
    await user.click(remove);
    expect(api.togglePin).toHaveBeenCalledWith(CHROME.id);
    await waitFor(() => expect(toast()).toBe("Removed Google Chrome from Favorites"));
  });

  it("right-click selects the row it was used on", async () => {
    await setup();
    const row = screen.getByText("Spotify").closest(".row")!;
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(selectedRow()).toHaveTextContent("Spotify"));
    expect(document.querySelector(".actions__title")).toHaveTextContent("Spotify");
  });

  it("Ctrl+K opens the actions menu and Esc closes it", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>}k{/Control}");
    expect(document.querySelector(".actions")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(document.querySelector(".actions")).not.toBeInTheDocument();
    expect(api.hide).not.toHaveBeenCalled();
  });
});

describe("screens", () => {
  it("shows the welcome screen until onboarding is done", async () => {
    api.getSettings.mockResolvedValue(makeSettings({ onboarded: false }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Welcome to Fyn");
    await user.click(screen.getByRole("button", { name: /Get Started/ }));
    expect(api.setOnboarded).toHaveBeenCalledWith(true);
    await screen.findByPlaceholderText(/Search apps/);
  });

  it("brings the welcome screen back on the next open if it was dismissed by hiding", async () => {
    api.getSettings.mockResolvedValue(makeSettings({ onboarded: false }));
    render(<App />);
    await screen.findByText("Welcome to Fyn");
    act(() => emit("fyn://hidden"));
    await screen.findByPlaceholderText(/Search apps/);
    act(() => emit("fyn://shown"));
    await screen.findByText("Welcome to Fyn");
  });

  it("Ctrl+, opens Settings and Esc comes back", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>},{/Control}");
    await screen.findByRole("heading", { name: "Settings" });
    await user.keyboard("{Escape}");
    await screen.findByPlaceholderText(/Search apps/);
  });

  it("the tray's Settings item opens Settings", async () => {
    await setup();
    act(() => emit("fyn://open-settings"));
    await screen.findByRole("heading", { name: "Settings" });
  });

  it("commands can open the emoji and colour pickers", async () => {
    const { user, input } = await setup();
    await user.type(input, "pick color");
    await screen.findByText("Commands");
    await user.keyboard("{Enter}");
    await screen.findByText("Pick from Screen");
  });

  it("hiding resets the search and goes back to the home screen", async () => {
    const { user, input } = await setup();
    await user.type(input, "abc");
    await user.keyboard("{Control>},{/Control}");
    await screen.findByRole("heading", { name: "Settings" });
    act(() => emit("fyn://hidden"));
    expect(await screen.findByPlaceholderText(/Search apps/)).toHaveValue("");
  });

  it("applies Fyn's saved theme", async () => {
    api.getSettings.mockResolvedValue(makeSettings({ theme: "dark" }));
    await setup();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });
});

describe("updates and dev menu", () => {
  it("shows an update pill when the backend finds an update", async () => {
    await setup();
    act(() => emit("fyn://update-available", { version: "1.2.3", currentVersion: "0.1.0", notes: null }));
    expect(await screen.findByText("Update 1.2.3 available")).toBeInTheDocument();
  });

  it("the Check for Updates command reports the result", async () => {
    const { user, input } = await setup();
    await user.type(input, "check for updates");
    await screen.findByText("Commands");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(toast()).toBe("Fyn is up to date"));
  });

  it("Ctrl+Shift+D opens the developer menu", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>}{Shift>}D{/Shift}{/Control}");
    await waitFor(() =>
      expect(document.querySelector(".actions__title")).toHaveTextContent("Developer: open a screen or state"),
    );
    await user.click(screen.getByText("Show Welcome Screen"));
    await screen.findByText("Welcome to Fyn");
  });

  it("reloads the home screen when apps change", async () => {
    await setup();
    api.getHome.mockResolvedValue(makeHome({ favorites: [], suggestions: [], applications: [CODE] }));
    act(() => emit("fyn://apps-changed"));
    await waitFor(() => expect(screen.queryByText("Favorites")).not.toBeInTheDocument());
  });
});
