import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSettings } from "../test/fixtures";
import { api, clipboard, installClipboard, resetApi } from "../test/mockIpc";
import { ActionPanel } from "./ActionPanel";
import { ColorView } from "./ColorView";
import EmojiView from "./EmojiView";
import { WelcomeView } from "./WelcomeView";

vi.mock("../lib/ipc", async (orig) => (await import("../test/mockIpc")).mockIpcModule(await orig()));

beforeEach(() => resetApi());

function userWithClipboard() {
  const user = userEvent.setup();
  installClipboard();
  return user;
}

const toast = () => document.querySelector(".toast")?.textContent ?? null;

describe("WelcomeView", () => {
  const setup = () => {
    const onDone = vi.fn();
    const onChangeHotkey = vi.fn();
    render(<WelcomeView settings={makeSettings({ hotkey: "Alt+Space" })} onDone={onDone} onChangeHotkey={onChangeHotkey} />);
    return { user: userEvent.setup(), onDone, onChangeHotkey };
  };

  it("teaches the current hotkey", () => {
    setup();
    expect(screen.getByText("Welcome to Fyn")).toBeInTheDocument();
    expect(screen.getByText("Alt")).toBeInTheDocument();
  });

  it("Get Started finishes (by click or Enter)", async () => {
    const { user, onDone } = setup();
    await user.keyboard("{Enter}");
    expect(onDone).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /Get Started/ }));
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("Esc also finishes", async () => {
    const { user, onDone } = setup();
    await user.keyboard("{Escape}");
    expect(onDone).toHaveBeenCalled();
  });

  it("Enter on Change opens the shortcut setting without also finishing", async () => {
    const { user, onDone, onChangeHotkey } = setup();
    screen.getByRole("button", { name: "Change" }).focus();
    await user.keyboard("{Enter}");
    expect(onChangeHotkey).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("toggles launch at login", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("switch"));
    expect(api.setAutostart).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });
});

describe("EmojiView", () => {
  it("searches and copies the selected emoji with Enter", async () => {
    const user = userWithClipboard();
    render(<EmojiView onBack={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("Search emoji…"), "grinning face");
    await user.keyboard("{Enter}");
    expect(clipboard.writeText).toHaveBeenCalledWith("😀");
    await waitFor(() => expect(toast()).toBe("Copied 😀 to clipboard"));
  });

  it("moves through the grid with the arrow keys", async () => {
    const user = userWithClipboard();
    render(<EmojiView onBack={vi.fn()} />);
    screen.getByPlaceholderText("Search emoji…").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowDown}{ArrowLeft}");
    expect(document.querySelector(".emoji-cell--selected")).toHaveAttribute("data-index", "11");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(document.querySelector(".emoji-cell--selected")).toHaveAttribute("data-index", "0"); // clamped
  });

  it("remembers recently used emoji", async () => {
    const user = userWithClipboard();
    render(<EmojiView onBack={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("Search emoji…"), "rocket");
    await user.keyboard("{Enter}");
    await user.clear(screen.getByPlaceholderText("Search emoji…"));
    expect(await screen.findByText("Recently Used")).toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<EmojiView onBack={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("Search emoji…"), "qqzzxx");
    expect(screen.getByText("No emoji for “qqzzxx”")).toBeInTheDocument();
  });

  it("Esc clears the search, then goes back", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<EmojiView onBack={onBack} />);
    const input = screen.getByPlaceholderText("Search emoji…");
    await user.type(input, "cat");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(onBack).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalled();
  });

  it("shows copy errors", async () => {
    const user = userWithClipboard();
    clipboard.writeText.mockRejectedValueOnce(new Error("Clipboard blocked"));
    render(<EmojiView onBack={vi.fn()} />);
    screen.getByPlaceholderText("Search emoji…").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(toast()).toBe("Clipboard blocked"));
  });
});

describe("ColorView", () => {
  const input = () => screen.getByPlaceholderText(/Type a color/);

  it("starts from the colour it was opened with", () => {
    render(<ColorView initial="#ff0000" onBack={vi.fn()} />);
    expect(screen.getByText("rgb(255, 0, 0)")).toBeInTheDocument();
    expect(screen.getByText("hsl(0, 100%, 50%)")).toBeInTheDocument();
  });

  it("converts what you type and copies the chosen format", async () => {
    const user = userWithClipboard();
    render(<ColorView onBack={vi.fn()} />);
    await user.type(input(), "rgb(0, 128, 0)");
    expect(screen.getAllByText("#008000").length).toBeGreaterThan(0);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}"); // Pick → HEX → RGB
    expect(clipboard.writeText).toHaveBeenCalledWith("rgb(0, 128, 0)");
    await waitFor(() => expect(toast()).toBe("Copied rgb(0, 128, 0)"));
  });

  it("keeps the last valid colour while you're mid-typing", async () => {
    const user = userEvent.setup();
    render(<ColorView initial="#0000ff" onBack={vi.fn()} />);
    await user.clear(input());
    await user.type(input(), "#12");
    expect(screen.getByText("Not a color yet")).toBeInTheDocument();
    expect(screen.getByText("rgb(0, 0, 255)")).toBeInTheDocument();
  });

  it("explains when screen picking isn't available", async () => {
    const user = userEvent.setup();
    render(<ColorView onBack={vi.fn()} />);
    input().focus();
    await user.keyboard("{Enter}"); // "Pick from Screen" is selected first
    await waitFor(() => expect(toast()).toBe("Picking from the screen isn't supported here"));
    expect(api.suspendAutoHide).not.toHaveBeenCalled();
  });

  it("picks from the screen without letting the launcher hide", async () => {
    const open = vi.fn().mockResolvedValue({ sRGBHex: "#123456" });
    vi.stubGlobal("EyeDropper", class { open = open; });
    try {
      const user = userEvent.setup();
      render(<ColorView onBack={vi.fn()} />);
      input().focus();
      await user.keyboard("{Control>}p{/Control}");
      await waitFor(() => expect(input()).toHaveValue("#123456"));
      expect(api.suspendAutoHide).toHaveBeenNthCalledWith(1, true);
      expect(api.suspendAutoHide).toHaveBeenLastCalledWith(false);
      expect(document.querySelectorAll(".color-chip")).toHaveLength(1); // remembered
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-enables auto-hide even if picking is cancelled", async () => {
    vi.stubGlobal("EyeDropper", class { open = vi.fn().mockRejectedValue(new Error("AbortError")); });
    try {
      const user = userEvent.setup();
      render(<ColorView onBack={vi.fn()} />);
      input().focus();
      await user.keyboard("{Control>}p{/Control}");
      await waitFor(() => expect(api.suspendAutoHide).toHaveBeenLastCalledWith(false));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Esc clears, then goes back", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<ColorView initial="#fff" onBack={onBack} />);
    input().focus();
    await user.keyboard("{Escape}");
    expect(input()).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalled();
  });
});

describe("ActionPanel", () => {
  const actions = [
    { id: "open", title: "Open Application", keys: ["↵"] },
    { id: "pin", title: "Add to Favorites" },
  ];

  it("runs the chosen action", async () => {
    const onRun = vi.fn();
    render(<ActionPanel title="Code" actions={actions} onRun={onRun} onClose={vi.fn()} />);
    await userEvent.setup().click(screen.getByText("Add to Favorites"));
    expect(onRun).toHaveBeenCalledWith("pin");
  });

  it("filters actions as you type", async () => {
    const user = userEvent.setup();
    render(<ActionPanel title="Code" actions={actions} onRun={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText("Search for actions…"), "fav");
    expect(screen.queryByText("Open Application")).not.toBeInTheDocument();
    expect(screen.getByText("Add to Favorites")).toBeInTheDocument();
  });

  it("closes on Esc, Ctrl+K, outside click and outside right-click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ActionPanel title="Code" actions={actions} onRun={vi.fn()} onClose={onClose} />);
    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}k{/Control}");
    fireEvent.mouseDown(document.querySelector(".actions-backdrop")!);
    fireEvent.contextMenu(document.querySelector(".actions-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("opens at the pointer and stays inside the window", () => {
    Object.defineProperty(window, "innerWidth", { value: 750, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 474, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 320, height: 200, top: 0, left: 0, right: 320, bottom: 200, x: 0, y: 0, toJSON() {},
    });
    const { rerender } = render(
      <ActionPanel title="Code" actions={actions} onRun={vi.fn()} onClose={vi.fn()} anchor={{ x: 100, y: 50 }} />,
    );
    const el = document.querySelector<HTMLElement>(".actions")!;
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("50px");

    // Near the bottom-right corner it flips left and up.
    rerender(<ActionPanel title="Code" actions={actions} onRun={vi.fn()} onClose={vi.fn()} anchor={{ x: 700, y: 450 }} />);
    expect(el.style.left).toBe("380px");
    expect(el.style.top).toBe("250px");
  });
});
