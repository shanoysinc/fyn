import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AppKind = "desktop" | "store" | "link";

export interface Item {
  id: string;
  name: string;
  kind: AppKind;
  icon: string | null;
  path: string;
  pinned: boolean;
  canRunAsAdmin: boolean;
  matches: number[];
}

export interface Home {
  favorites: Item[];
  suggestions: Item[];
  applications: Item[];
  /** Every pin in order: app ids, "cmd:…" built-in commands and "web:…" websites. */
  pins: string[];
}

export type SearchEngine = "google" | "duckduckgo" | "bing";
export type Theme = "system" | "light" | "dark";
/** Favorites and Suggestions as a row of icons ("grid") or a "list". */
export type HomeLayout = "grid" | "list";

export interface Settings {
  hotkey: string;
  hotkeyError: string | null;
  autostart: boolean;
  appCount: number;
  version: string;
  onboarded: boolean;
  searchEngine: SearchEngine;
  theme: Theme;
  homeLayout: HomeLayout;
}

export interface PathInfo {
  path: string;
  isDir: boolean;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export type SystemCommandId =
  | "lock"
  | "sleep"
  | "restart"
  | "shutdown"
  | "signout"
  | "empty-recycle-bin"
  | "toggle-dark-mode";

export const api = {
  getHome: () => invoke<Home>("get_home"),
  search: (query: string) => invoke<Item[]>("search", { query }),
  launch: (id: string, admin = false) => invoke<void>("launch", { id, admin }),
  reveal: (id: string) => invoke<void>("reveal", { id }),
  togglePin: (id: string) => invoke<boolean>("toggle_pin", { id }),
  movePin: (id: string, delta: number) => invoke<void>("move_pin", { id, delta }),
  hide: () => invoke<void>("hide_window"),
  getSettings: () => invoke<Settings>("get_settings"),
  setHotkey: (hotkey: string) => invoke<string>("set_hotkey", { hotkey }),
  suspendHotkey: (suspended: boolean) => invoke<void>("suspend_hotkey", { suspended }),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  rescan: () => invoke<void>("rescan"),
  setOnboarded: (done: boolean) => invoke<void>("set_onboarded", { done }),
  setSearchEngine: (engine: SearchEngine) => invoke<void>("set_search_engine", { engine }),
  setTheme: (theme: Theme) => invoke<void>("set_theme", { theme }),
  setHomeLayout: (layout: HomeLayout) => invoke<void>("set_home_layout", { layout }),
  /** Resolves to a message to show the user, if any. */
  runSystemCommand: (command: SystemCommandId) => invoke<string | null>("run_system_command", { command }),
  openSettingsPage: (uri: string) => invoke<void>("open_settings_page", { uri }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  checkPath: (path: string) => invoke<PathInfo | null>("check_path", { path }),
  openPath: (path: string, reveal = false) => invoke<void>("open_path", { path, reveal }),
  /** Eyedropper: hides Fyn until the next click anywhere; resolves to "#RRGGBB" or null if cancelled. */
  pickScreenColor: () => invoke<string | null>("pick_screen_color"),
  /** First frame with data is drawn; the backend shows the window on a manual start and says what it did. */
  uiReady: () => invoke<"showing" | "visible" | "hidden">("ui_ready"),
  checkForUpdate: () => invoke<UpdateInfo | null>("check_for_update"),
  installUpdate: () => invoke<void>("install_update"),
};

export const events = {
  shown: "fyn://shown",
  hidden: "fyn://hidden",
  appsChanged: "fyn://apps-changed",
  openSettings: "fyn://open-settings",
  updateAvailable: "fyn://update-available",
} as const;

export function on<T = unknown>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | undefined;
  let disposed = false;
  listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

const iconCache = new Map<string, string>();
export function iconUrl(path: string): string {
  let url = iconCache.get(path);
  if (!url) {
    url = convertFileSrc(path);
    iconCache.set(path, url);
  }
  return url;
}

/** Apply Fyn's own appearance to the page. "system" follows Windows via prefers-color-scheme. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong";
}
