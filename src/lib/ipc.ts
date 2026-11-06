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
}

export interface Settings {
  hotkey: string;
  hotkeyError: string | null;
  autostart: boolean;
  appCount: number;
  version: string;
}

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
};

export const events = {
  shown: "fyn://shown",
  hidden: "fyn://hidden",
  appsChanged: "fyn://apps-changed",
  openSettings: "fyn://open-settings",
} as const;

export function on(event: string, handler: () => void): () => void {
  let unlisten: UnlistenFn | undefined;
  let disposed = false;
  listen(event, handler).then((fn) => {
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

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong";
}
