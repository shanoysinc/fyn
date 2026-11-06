import type { Home, Item, Settings } from "../lib/ipc";

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
