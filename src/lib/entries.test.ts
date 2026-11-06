import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  launch: vi.fn(),
  runSystemCommand: vi.fn(),
  openSettingsPage: vi.fn(),
  openUrl: vi.fn(),
  openPath: vi.fn(),
}));
const copyText = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./ipc", () => ({ api, copyText }));

import {
  COMMANDS,
  PREFIXES,
  appEntry,
  asUrl,
  looksLikePath,
  matchCommands,
  quickEntries,
  webFallbacks,
  type Ctx,
} from "./entries";
import { CODE } from "../test/fixtures";

const ctx: Ctx = { openView: vi.fn(), checkForUpdates: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe("asUrl", () => {
  it.each([
    ["github.com", "https://github.com"],
    ["github.com/foo/bar", "https://github.com/foo/bar"],
    ["google.com/search?q=1", "https://google.com/search?q=1"],
    ["https://x.y/z", "https://x.y/z"],
    ["HTTP://Example.com", "HTTP://Example.com"],
    ["www.example.zz", "https://www.example.zz"],
    ["docs.rs/serde", "https://docs.rs/serde"],
    ["localhost:3000", "http://localhost:3000"],
    ["localhost/admin", "http://localhost/admin"],
  ])("%s -> %s", (q, url) => expect(asUrl(q)).toBe(url));

  it.each(["vsc", "node.js", "a.b", "main.rs", "script.sh", "readme.md", "1.2.3", "localhost", "two words.com", "me@x.com", ""])(
    "%j is not a URL",
    (q) => expect(asUrl(q)).toBeNull(),
  );
});

describe("looksLikePath", () => {
  it.each([String.raw`C:\Users`, "C:/Users", "~", String.raw`~\Downloads`, "%APPDATA%", String.raw`\\server\share`, `"C:\\x"`])(
    "%s looks like a path",
    (q) => expect(looksLikePath(q)).toBe(true),
  );

  it.each(["chrome", "c:", "~foo", "%", "50% off"])("%s does not", (q) => expect(looksLikePath(q)).toBe(false));
});

describe("matchCommands", () => {
  const titles = (q: string) => matchCommands(q).entries.map((e) => e.title);

  it.each([
    ["lock", "Lock Screen"],
    ["wifi", "Wi-Fi Settings"],
    ["shut", "Shut Down"],
    ["reboot", "Restart"],
    ["emoji", "Search Emoji"],
    ["eyedropper", "Pick Color"],
    ["bluetooth", "Bluetooth Settings"],
    ["volume", "Sound Settings"],
    ["tdm", "Toggle Windows Dark Mode"],
  ])("%s finds %s first", (q, title) => expect(titles(q)[0]).toBe(title));

  it("returns nothing (and best 0) for unrelated text", () => {
    expect(matchCommands("qqzz")).toEqual({ entries: [], best: 0 });
  });

  it("caps the number of command results", () => {
    expect(matchCommands("s").entries.length).toBeLessThanOrEqual(8);
  });

  it("marks session-ending commands as needing confirmation", () => {
    for (const id of ["sys:restart", "sys:shutdown", "sys:signout", "sys:empty-recycle-bin"]) {
      expect(COMMANDS.find((c) => c.id === id)?.confirm).toBeTruthy();
    }
    for (const id of ["sys:lock", "sys:sleep", "sys:toggle-dark-mode"]) {
      expect(COMMANDS.find((c) => c.id === id)?.confirm).toBeUndefined();
    }
  });

  it("has unique ids and valid ms-settings pages", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COMMANDS.filter((c) => c.id.startsWith("ms:"))) {
      expect(c.id.slice(3)).toMatch(/^[a-z0-9-]+$/); // must pass the Rust-side validation
    }
  });

  it("runs the right backend command", async () => {
    await matchCommands("lock").entries[0].primary.run(ctx);
    expect(api.runSystemCommand).toHaveBeenCalledWith("lock");

    await matchCommands("bluetooth").entries[0].primary.run(ctx);
    expect(api.openSettingsPage).toHaveBeenCalledWith("ms-settings:bluetooth");

    await matchCommands("emoji").entries[0].primary.run(ctx);
    expect(ctx.openView).toHaveBeenCalledWith("emoji");

    await matchCommands("check for updates").entries[0].primary.run(ctx);
    expect(ctx.checkForUpdates).toHaveBeenCalled();
  });
});

describe("web search", () => {
  it("offers the default engine first, then one alternative", () => {
    expect(webFallbacks("rust", "google").map((e) => e.title)).toEqual([
      "Search Google for “rust”",
      "Search DuckDuckGo for “rust”",
    ]);
    expect(webFallbacks("rust", "bing").map((e) => e.title)).toEqual([
      "Search Bing for “rust”",
      "Search Google for “rust”",
    ]);
    expect(webFallbacks("   ", "google")).toEqual([]);
  });

  it("URL-encodes the query", async () => {
    await webFallbacks("c++ & you", "duckduckgo")[0].primary.run(ctx);
    expect(api.openUrl).toHaveBeenCalledWith("https://duckduckgo.com/?q=c%2B%2B%20%26%20you");
  });

  it("can copy the search URL", async () => {
    const msg = await webFallbacks("x", "google")[0].actions![0].run(ctx);
    expect(copyText).toHaveBeenCalledWith("https://www.google.com/search?q=x");
    expect(msg).toBe("Copied URL");
  });

  it("every prefix points at an https URL", () => {
    for (const site of Object.values(PREFIXES)) expect(site.url).toMatch(/^https:\/\//);
  });
});

describe("quickEntries", () => {
  const kinds = (q: string) => quickEntries(q, null).map((e) => e.subtitle);

  it("recognises site prefixes", async () => {
    const [entry] = quickEntries("yt lofi beats", null);
    expect(entry.title).toBe("Search YouTube for “lofi beats”");
    await entry.primary.run(ctx);
    expect(api.openUrl).toHaveBeenCalledWith("https://www.youtube.com/results?search_query=lofi%20beats");
  });

  it("is case-insensitive for prefixes and ignores unknown ones", () => {
    expect(kinds("GH tauri")).toEqual(["Web Search"]);
    expect(kinds("zz tauri")).toEqual([]);
    expect(kinds("g")).toEqual([]);
  });

  it("shows the calculator and copies the plain answer", async () => {
    const [calc] = quickEntries("1000*1.5", null);
    expect(calc).toMatchObject({ subtitle: "Calculator", title: "1,500", prefix: "1000*1.5 =" });
    expect(await calc.primary.run(ctx)).toBe("Copied 1500");
    expect(copyText).toHaveBeenCalledWith("1500");
  });

  it("shows a colour with copy actions and an Open in Color Picker action", async () => {
    const [color] = quickEntries("#7c3aed", null);
    expect(color).toMatchObject({ subtitle: "Color", title: "#7C3AED", icon: { kind: "swatch", color: "#7C3AED" } });
    await color.primary.run(ctx);
    expect(copyText).toHaveBeenCalledWith("#7C3AED");
    await color.actions!.find((a) => a.id === "picker")!.run(ctx);
    expect(ctx.openView).toHaveBeenCalledWith("color", "#7C3AED");
  });

  it("only treats #/rgb()/hsl() input as a colour", () => {
    expect(kinds("red")).toEqual([]);
    expect(kinds("#zzz")).toEqual([]);
  });

  it("offers to open a URL", async () => {
    const [url] = quickEntries("github.com", null);
    expect(url.title).toBe("Open github.com");
    await url.primary.run(ctx);
    expect(api.openUrl).toHaveBeenCalledWith("https://github.com");
  });

  it("offers to open, reveal or copy an existing path", async () => {
    const [entry] = quickEntries("C:\\Users", { path: "C:\\Users", isDir: true });
    expect(entry).toMatchObject({ subtitle: "Folder", title: "C:\\Users", primary: { title: "Open Folder" } });
    await entry.primary.run(ctx);
    expect(api.openPath).toHaveBeenCalledWith("C:\\Users");
    await entry.actions!.find((a) => a.id === "reveal")!.run(ctx);
    expect(api.openPath).toHaveBeenCalledWith("C:\\Users", true);
    expect(quickEntries("C:\\x.txt", { path: "C:\\x.txt", isDir: false })[0].subtitle).toBe("File");
  });

  it("returns nothing for a plain app search", () => {
    expect(quickEntries("chrome", null)).toEqual([]);
  });
});

describe("appEntry", () => {
  it("wraps an installed app", async () => {
    const e = appEntry({ ...CODE, matches: [0, 1] });
    expect(e).toMatchObject({ id: CODE.id, title: CODE.name, subtitle: "Application", matches: [0, 1] });
    expect(e.app?.id).toBe(CODE.id);
    await e.primary.run(ctx);
    expect(api.launch).toHaveBeenCalledWith(CODE.id);
  });

  it("labels Store apps and shortcuts", () => {
    expect(appEntry({ ...CODE, kind: "store" }).subtitle).toBe("Store App");
    expect(appEntry({ ...CODE, kind: "link" }).subtitle).toBe("Shortcut");
  });
});
