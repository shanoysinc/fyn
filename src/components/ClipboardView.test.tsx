import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TINY_PNG, makeClip, makeClipStatus, makeImageClip, makeSettings } from "../test/fixtures";
import { api, emit, resetApi } from "../test/mockIpc";
import { formatBytes, relativeTime } from "../lib/format";
import { ClipboardView } from "./ClipboardView";
import { SettingsView } from "./SettingsView";

vi.mock("../lib/ipc", async (orig) => (await import("../test/mockIpc")).mockIpcModule(await orig()));

const LINK = makeClip({ id: 3, text: "https://github.com/shanoysinc/fyn", chars: 33, source: "chrome.exe" });
const NOTE = makeClip({ id: 2, text: "Meeting moved to 3pm\nsecond line", chars: 31 });
const COLOR = makeClip({ id: 4, text: "#7c3aed", chars: 7, source: null });

beforeEach(() => {
  resetApi();
  api.clipboardList.mockResolvedValue([COLOR, LINK, NOTE]);
});

const toast = () => document.querySelector(".toast")?.textContent ?? null;
const selectedRow = () => document.querySelector('.row[data-selected="true"]');

async function setup() {
  const user = userEvent.setup();
  const onBack = vi.fn();
  render(<ClipboardView onBack={onBack} />);
  const input = await screen.findByPlaceholderText("Search clipboard history…");
  await waitFor(() => expect(document.querySelectorAll(".clip__row")).toHaveLength(3));
  return { user, onBack, input };
}

describe("turning clipboard history on", () => {
  beforeEach(() => api.clipboardStatus.mockResolvedValue(makeClipStatus({ enabled: false })));

  it("explains what it keeps and how it protects you before anything is recorded", async () => {
    render(<ClipboardView onBack={vi.fn()} />);
    expect(await screen.findByText(/Copies from password managers are never recorded/)).toBeInTheDocument();
    expect(screen.getByText(/never kept, not even for a moment/)).toBeInTheDocument();
    expect(api.clipboardList).not.toHaveBeenCalled();
  });

  it("Enter turns it on and shows the history", async () => {
    const user = userEvent.setup();
    render(<ClipboardView onBack={vi.fn()} />);
    // The real backend reports enabled once it has been turned on.
    api.setClipboardSettings.mockImplementationOnce(async (s) => {
      api.clipboardStatus.mockResolvedValue(makeClipStatus({ ...s, enabled: true }));
      return makeClipStatus({ ...s, enabled: true });
    });
    await screen.findByText(/Turn On/);
    await user.keyboard("{Enter}");
    expect(api.setClipboardSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    await screen.findByPlaceholderText("Search clipboard history…");
  });

  it("Not Now goes back without turning it on (also via Enter on the button)", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<ClipboardView onBack={onBack} />);
    (await screen.findByRole("button", { name: "Not Now" })).focus();
    await user.keyboard("{Enter}");
    expect(onBack).toHaveBeenCalled();
    expect(api.setClipboardSettings).not.toHaveBeenCalled();
  });
});

describe("the history", () => {
  it("lists items newest first with an icon for what they are", async () => {
    await setup();
    const rows = [...document.querySelectorAll(".clip__row")];
    expect(rows[0]).toHaveTextContent("#7c3aed");
    expect(rows[0].querySelector(".glyph-tile--swatch")).not.toBeNull(); // colour swatch
    expect(rows[1]).toHaveTextContent("https://github.com/shanoysinc/fyn");
    expect(rows[2]).toHaveTextContent("Meeting moved to 3pm"); // first line only
    expect(rows[2]).not.toHaveTextContent("second line");
  });

  it("previews the selected item with where and when it was copied", async () => {
    const { user } = await setup();
    await user.keyboard("{ArrowDown}");
    const preview = document.querySelector(".clip__preview")!;
    expect(preview).toHaveTextContent("https://github.com/shanoysinc/fyn");
    expect(preview).toHaveTextContent("chrome");
    expect(preview).toHaveTextContent("33");
  });

  it("search filters by text", async () => {
    const { user, input } = await setup();
    await user.type(input, "meeting");
    await waitFor(() => expect(document.querySelectorAll(".clip__row")).toHaveLength(1));
    expect(selectedRow()).toHaveTextContent("Meeting moved");
  });

  it("Enter pastes into the previous app", async () => {
    const { user } = await setup();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(api.clipboardPaste).toHaveBeenCalledWith(3);
  });

  it("Ctrl+Enter copies without pasting; Ctrl+Backspace deletes", async () => {
    const { user } = await setup();
    await user.keyboard("{ArrowDown}{Control>}{Enter}{/Control}");
    expect(api.clipboardCopy).toHaveBeenCalledWith(3);
    expect(api.clipboardPaste).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Backspace}{/Control}");
    expect(api.clipboardDelete).toHaveBeenCalledWith(3);
  });

  it("Clear all asks for a second press", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByText("Clear All History…"));
    expect(api.clipboardClear).not.toHaveBeenCalled();
    expect(toast()).toBe("Press again to delete all clipboard history");
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByText("Press Again to Clear All"));
    expect(api.clipboardClear).toHaveBeenCalled();
  });

  it("pauses and resumes recording", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByText("Pause for 15 Minutes"));
    expect(api.clipboardPause).toHaveBeenCalledWith(15);
    await user.click(await screen.findByText("Paused · Resume").catch(async () => {
      await waitFor(() => expect(toast()).toBeNull(), { timeout: 3000 });
      return screen.getByText("Paused · Resume");
    }));
    expect(api.clipboardPause).toHaveBeenLastCalledWith(null);
  });

  it("refreshes when something new is copied", async () => {
    await setup();
    api.clipboardList.mockResolvedValue([makeClip({ id: 9, text: "just copied" }), COLOR, LINK, NOTE]);
    act(() => emit("fyn://clipboard-changed"));
    await waitFor(() => expect(document.querySelectorAll(".clip__row")).toHaveLength(4));
  });

  it("Esc clears the search, then goes back", async () => {
    const { user, input, onBack } = await setup();
    await user.type(input, "x");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalled();
  });

  it("explains an empty history", async () => {
    api.clipboardList.mockResolvedValue([]);
    render(<ClipboardView onBack={vi.fn()} />);
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  });
});

describe("relativeTime", () => {
  const now = 1_000_000;
  it.each([
    [now - 10, "Just now"],
    [now - 120, "2m ago"],
    [now - 3 * 3600, "3h ago"],
    [now - 86_400, "Yesterday"],
    [now - 5 * 86_400, "5d ago"],
  ])("%i -> %s", (t, label) => expect(relativeTime(t, now)).toBe(label));
});

describe("clipboard settings", () => {
  async function setupSettings() {
    api.getSettings.mockResolvedValue(makeSettings());
    const user = userEvent.setup();
    render(<SettingsView onBack={vi.fn()} onShowWelcome={vi.fn()} update={null} onUpdate={vi.fn()} />);
    await screen.findByText("Clipboard history");
    return user;
  }

  it("turns clipboard history off", async () => {
    const user = await setupSettings();
    await user.click(screen.getByRole("switch", { name: "Clipboard history" }));
    expect(api.setClipboardSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("changes retention and clipboard clearing (there's no option to keep passwords)", async () => {
    const user = await setupSettings();
    await user.click(screen.getByRole("radio", { name: "30 days" }));
    expect(api.setClipboardSettings).toHaveBeenLastCalledWith(expect.objectContaining({ retentionDays: 30 }));
    expect(screen.queryByText(/Password-like copies/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Clear passwords from the clipboard" }));
    expect(api.setClipboardSettings).toHaveBeenLastCalledWith(expect.objectContaining({ clearSensitive: false }));
  });

  it("adds and removes ignored apps", async () => {
    const user = await setupSettings();
    await user.type(screen.getByPlaceholderText(/Add app/), "MyBank{Enter}");
    expect(api.setClipboardSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoredApps: ["keepassxc.exe", "1password.exe", "mybank.exe"] }),
    );
    await user.click(screen.getByRole("button", { name: "Remove keepassxc.exe" }));
    expect(api.setClipboardSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoredApps: expect.not.arrayContaining(["keepassxc.exe"]) }),
    );
  });

  it("shows validation errors from the backend", async () => {
    api.setClipboardSettings.mockRejectedValueOnce("\"bad\" isn't an app file name like keepassxc.exe");
    const user = await setupSettings();
    await user.type(screen.getByPlaceholderText(/Add app/), "bad{Enter}");
    expect(await screen.findByText(/isn't an app file name/)).toBeInTheDocument();
  });
});

describe("images", () => {
  const SHOT = makeImageClip({ id: 7 });

  beforeEach(() => {
    api.clipboardStatus.mockResolvedValue(makeClipStatus({ includeImages: true, imageCount: 1, imageBytes: 2_400_000 }));
    api.clipboardList.mockResolvedValue([SHOT, NOTE]);
    api.clipboardImage.mockResolvedValue(TINY_PNG + "#full");
  });

  async function setupImages() {
    const user = userEvent.setup();
    render(<ClipboardView onBack={vi.fn()} />);
    const input = await screen.findByPlaceholderText("Search clipboard history…");
    await waitFor(() => expect(document.querySelectorAll(".clip__row")).toHaveLength(2));
    return { user, input };
  }

  it("shows a thumbnail and the dimensions in the list", async () => {
    await setupImages();
    const row = document.querySelectorAll(".clip__row")[0];
    expect(row).toHaveTextContent("Image · 1920 × 1080");
    expect(row.querySelector("img.clip__thumb")).toHaveAttribute("src", TINY_PNG);
  });

  it("loads the full image only when it's selected, with its size", async () => {
    await setupImages();
    await waitFor(() => expect(api.clipboardImage).toHaveBeenCalledWith(7));
    await waitFor(() =>
      expect(document.querySelector(".clip__image img")).toHaveAttribute("src", TINY_PNG + "#full"),
    );
    const meta = document.querySelector(".clip__meta")!;
    expect(meta).toHaveTextContent("1920 × 1080");
    expect(meta).toHaveTextContent("2.3 MB");
    expect(meta).toHaveTextContent("snippingtool");
    expect(api.clipboardImage).toHaveBeenCalledTimes(1);
  });

  it("Enter pastes the image", async () => {
    const { user } = await setupImages();
    await user.keyboard("{Enter}");
    expect(api.clipboardPaste).toHaveBeenCalledWith(7);
  });

  it("images are found by words like 'screenshot' or the app they came from", async () => {
    const { user, input } = await setupImages();
    await user.type(input, "screen");
    await waitFor(() => expect(document.querySelectorAll(".clip__row")).toHaveLength(1));
    expect(document.querySelector(".clip__row")).toHaveTextContent("Image");
    await user.clear(input);
    await user.type(input, "snipping");
    await waitFor(() => expect(document.querySelectorAll(".clip__row")).toHaveLength(1));
  });

  it("the empty history mentions images when they're on", async () => {
    api.clipboardList.mockResolvedValue([]);
    render(<ClipboardView onBack={vi.fn()} />);
    expect(await screen.findByText(/Copy some text or an image/)).toBeInTheDocument();
  });
});

describe("image settings", () => {
  it("is off by default and explains what turning it on means", async () => {
    api.getSettings.mockResolvedValue(makeSettings());
    const user = userEvent.setup();
    render(<SettingsView onBack={vi.fn()} onShowWelcome={vi.fn()} update={null} onUpdate={vi.fn()} />);
    const toggle = await screen.findByRole("switch", { name: "Include images" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/a screenshot of a password would be kept/)).toBeInTheDocument();
    await user.click(toggle);
    expect(api.setClipboardSettings).toHaveBeenLastCalledWith(expect.objectContaining({ includeImages: true }));
  });

  it("shows how many images are saved and how much space they use", async () => {
    api.getSettings.mockResolvedValue(makeSettings());
    api.clipboardStatus.mockResolvedValue(makeClipStatus({ includeImages: true, imageCount: 12, imageBytes: 19_300_000 }));
    render(<SettingsView onBack={vi.fn()} onShowWelcome={vi.fn()} update={null} onUpdate={vi.fn()} />);
    expect(await screen.findByText(/12 saved \(18\.4 MB\)/)).toBeInTheDocument();
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [1536, "2 KB"],
    [2_400_000, "2.3 MB"],
  ])("%i -> %s", (n, s) => expect(formatBytes(n)).toBe(s));
});

describe("turning images on from clipboard history", () => {
  it("says images are off and turns them on from the footer", async () => {
    const user = userEvent.setup();
    render(<ClipboardView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Images are off/ }));
    expect(api.setClipboardSettings).toHaveBeenCalledWith(expect.objectContaining({ includeImages: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Images are off/ })).not.toBeInTheDocument());
  });

  it("offers Turn On Images in the actions menu, only while they're off", async () => {
    const user = userEvent.setup();
    render(<ClipboardView onBack={vi.fn()} />);
    await screen.findByPlaceholderText("Search clipboard history…");
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByText("Turn On Images"));
    expect(api.setClipboardSettings).toHaveBeenCalledWith(expect.objectContaining({ includeImages: true }));
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByText("Turn On Images")).not.toBeInTheDocument();
  });

  it("doesn't nag once images are on", async () => {
    api.clipboardStatus.mockResolvedValue(makeClipStatus({ includeImages: true }));
    render(<ClipboardView onBack={vi.fn()} />);
    await screen.findByPlaceholderText("Search clipboard history…");
    expect(screen.queryByRole("button", { name: /Images are off/ })).not.toBeInTheDocument();
  });
});
