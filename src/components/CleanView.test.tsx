import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCategory, makeScanReport } from "../test/fixtures";
import { api, resetApi } from "../test/mockIpc";
import { CleanView, selection } from "./CleanView";
import { MiniAppsView } from "./MiniAppsView";

vi.mock("../lib/ipc", async (orig) => (await import("../test/mockIpc")).mockIpcModule(await orig()));

beforeEach(() => resetApi());

const toast = () => document.querySelector(".toast")?.textContent ?? null;
const row = (title: string) =>
  [...document.querySelectorAll<HTMLElement>(".clean__row")].find((r) => r.querySelector(".clean__title")?.textContent?.startsWith(title))!;

async function setup() {
  const user = userEvent.setup();
  const onBack = vi.fn();
  render(<CleanView onBack={onBack} />);
  await screen.findByText("npm cache");
  await waitFor(() => expect(screen.getByRole("button", { name: /Free/ })).not.toBeDisabled());
  return { user, onBack };
}

describe("Clean Windows", () => {
  it("shows each category with its size, free disk space, and the total to free", async () => {
    await setup();
    expect(row("npm cache")).toHaveTextContent("1.2 MB");
    expect(row("Gradle caches")).toHaveTextContent("20.0 MB");
    expect(row("Yarn cache")).toHaveTextContent("Not found");
    expect(screen.getByText(/26\.3 GB free|26\.2 GB free/)).toBeInTheDocument();
    // temp 0.2 + npm 1.3 + gradle 21.0 MB (Android is optional and off)
    expect(screen.getByRole("button", { name: /Free 21\.5 MB/ })).toBeInTheDocument();
  });

  it("switching a category off is saved and leaves it out of the clean", async () => {
    const { user } = await setup();
    await user.click(row("Gradle caches"));
    expect(api.setCleanSettings).toHaveBeenCalledWith({ enabled: ["temp", "npm"], protected: ["beacon", "emr"] });
    await waitFor(() => expect(screen.getByRole("button", { name: /Free 1\.4 MB/ })).toBeInTheDocument());
  });

  it("Space toggles the selected category from the keyboard", async () => {
    const { user } = await setup();
    await user.keyboard(" "); // first row: Temporary files
    expect(api.setCleanSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: ["npm", "gradle"] }));
  });

  it("needs a second Enter, then cleans only what's on, and rescans", async () => {
    api.cleanRun.mockResolvedValue({ freedBytes: 22_500_000, deletedFiles: 38, skippedFiles: 3, errors: [] });
    const { user } = await setup();
    await user.keyboard("{Enter}");
    expect(api.cleanRun).not.toHaveBeenCalled();
    expect(toast()).toBe("Press ↵ again to delete 21.5 MB");
    await user.keyboard("{Enter}");
    expect(api.cleanRun).toHaveBeenCalledWith(["temp", "npm", "gradle"], []);
    await waitFor(() => expect(toast()).toBe("Freed 21.5 MB. 3 files in use were skipped"));
    expect(api.cleanScan).toHaveBeenCalledTimes(2);
  });

  it("Android emulators are optional, picked one by one, and protected ones can't be picked", async () => {
    const { user } = await setup();
    expect(screen.queryByText("Pixel 7")).not.toBeInTheDocument(); // category is off
    await user.click(row("Android emulators"));
    await screen.findByText("Pixel 7");
    expect(row("Beacon Tablet")).toHaveTextContent("Protected");
    await user.click(row("Beacon Tablet"));
    await user.click(row("Pixel 7"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Free 3\.7 GB/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Free/ }));
    await user.click(screen.getByRole("button", { name: /Confirm/ }));
    expect(api.cleanRun).toHaveBeenCalledWith(["temp", "npm", "gradle"], ["avd:Pixel_7"]);
  });

  it("edits the protected names and rescans", async () => {
    const { user } = await setup();
    expect(screen.getByText("beacon")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Add a name/), "clinic{Enter}");
    expect(api.setCleanSettings).toHaveBeenLastCalledWith(expect.objectContaining({ protected: ["beacon", "emr", "clinic"] }));
    await user.click(screen.getByRole("button", { name: "Unprotect emr" }));
    expect(api.setCleanSettings).toHaveBeenLastCalledWith(expect.objectContaining({ protected: ["beacon", "clinic"] }));
    await waitFor(() => expect(api.cleanScan.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("Ctrl+R rescans and Esc goes back", async () => {
    const { user, onBack } = await setup();
    await user.keyboard("{Control>}r{/Control}");
    await waitFor(() => expect(api.cleanScan).toHaveBeenCalledTimes(2));
    await user.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalled();
  });

  it("can't clean when nothing is selected", async () => {
    api.cleanScan.mockResolvedValue(makeScanReport({ categories: [makeCategory({ id: "npm", bytes: 0, files: 0 })] }));
    render(<CleanView onBack={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Nothing selected/ })).toBeDisabled();
    expect(row("npm cache")).toHaveTextContent("Already clean");
  });
});

describe("selection", () => {
  it("adds up enabled, available categories and ticked, unprotected items", () => {
    const report = makeScanReport();
    report.categories.find((c) => c.id === "avd")!.enabled = true;
    const plan = selection(report, new Set(["avd:Pixel_7", "avd:Beacon_Tablet"]));
    expect(plan.categories).toEqual(["temp", "npm", "gradle"]);
    expect(plan.items).toEqual(["avd:Pixel_7"]); // the protected one never makes it in
    expect(plan.bytes).toBe(200_000 + 1_300_000 + 21_000_000 + 4_000_000_000);
  });

  it("ignores ticked items whose category is off", () => {
    expect(selection(makeScanReport(), new Set(["avd:Pixel_7"])).items).toEqual([]);
  });
});

describe("Mini Apps screen", () => {
  function setupMini(pinned: string[] = []) {
    const onOpen = vi.fn();
    const onTogglePin = vi.fn(async (_id: string, title: string) => `Added ${title} to Favorites`);
    render(<MiniAppsView onBack={vi.fn()} onOpen={onOpen} pinned={new Set(pinned)} onTogglePin={onTogglePin} />);
    return { user: userEvent.setup(), onOpen, onTogglePin };
  }

  it("lists the mini apps with app icons, and opens the selected one with Enter", async () => {
    const { user, onOpen } = setupMini();
    const titles = [...document.querySelectorAll(".miniapp__title")].map((t) => t.textContent);
    expect(titles).toEqual([
      "Clipboard History",
      "Clean Windows",
      "Pomodoro",
      "Port Killer",
      "Password Generator",
      "Dev Tools",
      "Color Picker",
      "Emoji Picker",
    ]);
    expect(document.querySelectorAll(".miniapp .mini-icon")).toHaveLength(8);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpen).toHaveBeenCalledWith("clean");
  });

  it("the star adds a mini app to Favorites without opening it", async () => {
    const { user, onOpen, onTogglePin } = setupMini();
    await user.click(screen.getByRole("button", { name: "Add Color Picker to Favorites" }));
    expect(onTogglePin).toHaveBeenCalledWith("cmd:fyn:color", "Color Picker");
    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(toast()).toBe("Added Color Picker to Favorites"));
  });

  it("shows which ones are already favorites", () => {
    setupMini(["cmd:fyn:clipboard"]);
    expect(screen.getByRole("button", { name: "Remove Clipboard History from Favorites" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Add Clean Windows to Favorites" })).toHaveAttribute("aria-pressed", "false");
  });

  it("Ctrl+Shift+P and right-click work too", async () => {
    const { user, onTogglePin, onOpen } = setupMini();
    await user.keyboard("{ArrowDown}{Control>}{Shift>}P{/Shift}{/Control}");
    expect(onTogglePin).toHaveBeenLastCalledWith("cmd:fyn:clean-windows", "Clean Windows");

    fireEvent.contextMenu(document.querySelectorAll(".miniapp")[7], { clientX: 50, clientY: 60 });
    await user.click(await screen.findByText("Add to Favorites", { selector: ".actions__item span" }));
    expect(onTogglePin).toHaveBeenLastCalledWith("cmd:fyn:emoji", "Emoji Picker");
    fireEvent.contextMenu(document.querySelectorAll(".miniapp")[7], { clientX: 50, clientY: 60 });
    await user.click(await screen.findByText("Open", { selector: ".actions__item span" }));
    expect(onOpen).toHaveBeenCalledWith("emoji");
  });
});
