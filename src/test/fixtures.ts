import type { ClipEntry, ClipStatus, Home, Item, Settings } from "../lib/ipc";

export function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: "lnk:code",
    name: "Visual Studio Code",
    kind: "desktop",
    icon: null,
    path: "C:\\Program Files\\Code\\Code.exe",
    pinned: false,
    canRunAsAdmin: true,
    matches: [],
    ...over,
  };
}

export const CODE = makeItem();
export const CHROME = makeItem({ id: "lnk:chrome", name: "Google Chrome", path: "C:\\Chrome\\chrome.exe" });
export const SPOTIFY = makeItem({
  id: "aumid:spotify",
  name: "Spotify",
  kind: "store",
  canRunAsAdmin: false,
  path: "Spotify",
});

export function makeHome(over: Partial<Home> = {}): Home {
  const favorites = over.favorites ?? [{ ...CHROME, pinned: true }];
  return {
    favorites,
    suggestions: [CODE],
    applications: [{ ...CHROME, pinned: true }, CODE, SPOTIFY],
    pins: favorites.map((f) => f.id),
    ...over,
  };
}

export function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    hotkey: "Ctrl+Space",
    hotkeyError: null,
    autostart: false,
    appCount: 3,
    version: "0.1.0",
    onboarded: true,
    searchEngine: "google",
    theme: "system",
    homeLayout: "list",
    ...over,
  };
}

export function makeClipStatus(over: Partial<ClipStatus> = {}): ClipStatus {
  return {
    enabled: true,
    retentionDays: 7,
    clearSensitive: true,
    includeImages: false,
    ignoredApps: ["keepassxc.exe", "1password.exe"],
    paused: false,
    pausedUntil: null,
    imageCount: 0,
    imageBytes: 0,
    ...over,
  };
}

export function makeClip(over: Partial<ClipEntry> = {}): ClipEntry {
  return {
    kind: "text",
    id: 1,
    text: "hello world",
    truncated: false,
    chars: 11,
    source: "code.exe",
    created: Math.floor(Date.now() / 1000) - 120,
    width: null,
    height: null,
    bytes: null,
    thumb: null,
    ...over,
  };
}

/** A 1×1 transparent PNG, as clipboard history sends images to the UI. */
export const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function makeImageClip(over: Partial<ClipEntry> = {}): ClipEntry {
  return makeClip({ kind: "image", text: "", chars: 0, width: 1920, height: 1080, bytes: 2_400_000, thumb: TINY_PNG, source: "snippingtool.exe", ...over });
}
