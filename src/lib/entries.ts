// Everything in the result list that isn't an installed app: built-in commands, Windows
// Settings pages, calculator, colours, URLs, paths and web searches.

import { calculate } from "./calc";
import { parseColor, toHex, toHslString, toRgbString } from "./color";
import { fuzzyMatch } from "./fuzzy";
import { api, copyText, type Item, type PathInfo, type SearchEngine, type SystemCommandId } from "./ipc";
import { MINI_APPS } from "../miniapps/registry";

/** "collection" = all favorites or all suggestions (arg "fav" / "sug"). */
export type View =
  | "root"
  | "settings"
  | "welcome"
  | "emoji"
  | "color"
  | "collection"
  | "clipboard"
  | "miniapps"
  | "clean"
  | "pomodoro"
  | "ports"
  | "passwords"
  | "devtools";

export type GlyphName =
  | "lock" | "moon" | "restart" | "power" | "logout" | "trash" | "contrast"
  | "emoji" | "droplet" | "gear" | "sparkle" | "download" | "globe" | "search"
  | "folder" | "file" | "calculator" | "sliders" | "grid" | "clipboard" | "text" | "doc" | "broom" | "apps"
  | "sparkles" | "eyedropper" | "timer" | "plug" | "key" | "code" | "copy" | "refresh" | "play" | "pause" | "skip" | "swap" | "flame" | "check";

export type EntryIcon =
  | { kind: "app"; item: Item }
  /** `gradient` makes it an app-style icon (mini apps). */
  | { kind: "glyph"; glyph: GlyphName; tint: string; gradient?: [string, string] }
  | { kind: "swatch"; color: string };

/** What a command may ask of the launcher. */
export interface Ctx {
  openView: (view: View, arg?: string) => void;
  checkForUpdates: () => void;
  /** Add/remove a pin; resolves to the toast message. */
  togglePin: (pinId: string, title: string) => Promise<string>;
  movePin: (pinId: string, delta: -1 | 1) => Promise<void>;
}

export interface EntryAction {
  id: string;
  title: string;
  keys?: string[];
  /** May resolve to a message for the footer toast. */
  run: (ctx: Ctx) => Promise<string | null | void> | string | null | void;
}

export interface Entry {
  id: string;
  title: string;
  /** Kind label on the right ("System", "Calculator"…). */
  subtitle: string;
  icon: EntryIcon;
  matches?: number[];
  /** Set for installed apps; those use the app actions in actions.ts. */
  app?: Item;
  /** Muted text before the title (the calculator's expression). */
  prefix?: string;
  primary: EntryAction;
  actions?: EntryAction[];
  /** Ask for a second ↵ before running `primary` ("restart your PC"). */
  confirm?: string;
  /** Id used to pin it to Favorites ("cmd:…" / "web:…"); apps use their own id. */
  pinId?: string;
  /** In Favorites (non-app entries; apps carry this on `app.pinned`). */
  pinned?: boolean;
}

/** Pin id prefixes; must match PIN_COMMAND / PIN_WEBSITE in src-tauri/src/commands.rs. */
export const PIN_COMMAND = "cmd:";
export const PIN_WEBSITE = "web:";

const TINT = {
  system: "#e5484d",
  power: "#f76b15",
  fyn: "#7c3aed",
  settings: "#64748b",
  web: "#0090ff",
  calc: "#f5a524",
  file: "#3b82f6",
};

const KIND_LABEL: Record<Item["kind"], string> = {
  desktop: "Application",
  store: "Store App",
  link: "Shortcut",
};

export function appEntry(item: Item): Entry {
  return {
    id: item.id,
    title: item.name,
    subtitle: KIND_LABEL[item.kind],
    icon: { kind: "app", item },
    matches: item.matches,
    app: item,
    primary: { id: "open", title: "Open Application", run: () => api.launch(item.id) },
  };
}

// ---------- built-in commands ----------

interface CommandDef {
  id: string;
  title: string;
  subtitle: string;
  glyph: GlyphName;
  tint: string;
  keywords: string[];
  primaryTitle: string;
  run: EntryAction["run"];
  confirm?: string;
  gradient?: [string, string];
}

const system = (
  id: SystemCommandId,
  title: string,
  glyph: GlyphName,
  keywords: string[],
  confirm?: string,
): CommandDef => ({
  id: `sys:${id}`,
  title,
  subtitle: "System",
  glyph,
  tint: confirm ? TINT.power : TINT.system,
  keywords,
  primaryTitle: "Run Command",
  run: () => api.runSystemCommand(id),
  confirm,
});

const settingsPage = (page: string, title: string, keywords: string[]): CommandDef => ({
  id: `ms:${page}`,
  title: `${title} Settings`,
  subtitle: "Settings Page",
  glyph: "sliders",
  tint: TINT.settings,
  keywords,
  primaryTitle: "Open Settings Page",
  run: () => api.openSettingsPage(`ms-settings:${page}`),
});

const fyn = (
  id: string,
  title: string,
  glyph: GlyphName,
  keywords: string[],
  run: EntryAction["run"],
  primaryTitle = "Open Command",
): CommandDef => ({ id: `fyn:${id}`, title, subtitle: "Fyn", glyph, tint: TINT.fyn, keywords, primaryTitle, run });

export const COMMANDS: CommandDef[] = [
  system("lock", "Lock Screen", "lock", ["lock", "lock pc", "away"]),
  system("sleep", "Sleep", "moon", ["suspend", "standby"]),
  system("restart", "Restart", "restart", ["reboot"], "restart your PC"),
  system("shutdown", "Shut Down", "power", ["shutdown", "power off", "turn off"], "shut down your PC"),
  system("signout", "Sign Out", "logout", ["log out", "logout", "log off", "sign off"], "sign out"),
  system("empty-recycle-bin", "Empty Recycle Bin", "trash", ["trash", "bin", "delete"], "empty the Recycle Bin"),
  system("toggle-dark-mode", "Toggle Windows Dark Mode", "contrast", ["dark mode", "light mode", "windows theme"]),

  fyn("miniapps", "Mini Apps", "apps", ["mini apps", "tools", "utilities", "apps"], (c) => c.openView("miniapps")),
  // Each mini app is also a command (searchable, pinnable), with its app icon.
  ...MINI_APPS.map((app) => ({
    ...fyn(app.id, app.title, app.glyph, app.keywords, (c) => c.openView(app.view), "Open"),
    subtitle: "Mini App",
    tint: app.gradient[1],
    gradient: app.gradient,
  })),
  fyn("settings", "Fyn Settings", "gear", ["preferences", "options", "config"], (c) => c.openView("settings")),
  fyn("updates", "Check for Updates", "download", ["update", "upgrade", "version"], (c) => c.checkForUpdates(), "Check Now"),
  fyn("welcome", "Welcome to Fyn", "sparkle", ["help", "tutorial", "tips", "onboarding", "getting started"], (c) =>
    c.openView("welcome"),
  ),
  // Keyboard route to the "View all" screens (the heading button is mouse-only).
  fyn("all-favorites", "View All Favorites", "grid", ["favorites", "pinned", "starred"], (c) =>
    c.openView("collection", "fav"),
  ),
  fyn("all-suggestions", "View All Suggestions", "grid", ["suggestions", "most used", "frequent"], (c) =>
    c.openView("collection", "sug"),
  ),

  settingsPage("network-wifi", "Wi-Fi", ["wifi", "wireless", "internet"]),
  settingsPage("bluetooth", "Bluetooth", ["devices", "headphones", "pair"]),
  settingsPage("display", "Display", ["screen", "monitor", "resolution", "brightness", "scale"]),
  settingsPage("nightlight", "Night Light", ["blue light", "warm"]),
  settingsPage("sound", "Sound", ["audio", "volume", "speakers", "microphone", "output"]),
  settingsPage("network-status", "Network", ["internet", "ethernet", "connection"]),
  settingsPage("network-vpn", "VPN", ["vpn"]),
  settingsPage("network-proxy", "Proxy", ["proxy"]),
  settingsPage("network-mobilehotspot", "Mobile Hotspot", ["hotspot", "tethering"]),
  settingsPage("notifications", "Notifications", ["alerts", "do not disturb", "focus"]),
  settingsPage("powersleep", "Power", ["battery", "sleep", "power plan", "screen timeout"]),
  settingsPage("batterysaver", "Battery", ["battery saver", "energy"]),
  settingsPage("storagesense", "Storage", ["disk", "space", "drive", "cleanup"]),
  settingsPage("appsfeatures", "Installed Apps", ["apps", "uninstall", "programs", "remove"]),
  settingsPage("defaultapps", "Default Apps", ["default browser", "file associations"]),
  settingsPage("startupapps", "Startup Apps", ["startup", "boot", "login items"]),
  settingsPage("personalization-background", "Background", ["wallpaper", "desktop background"]),
  settingsPage("colors", "Colors", ["dark mode", "light mode", "accent", "theme"]),
  settingsPage("themes", "Themes", ["theme", "personalization"]),
  settingsPage("taskbar", "Taskbar", ["start", "tray"]),
  settingsPage("multitasking", "Multitasking", ["snap", "virtual desktops", "alt tab"]),
  settingsPage("mousetouchpad", "Mouse", ["cursor", "scroll", "touchpad"]),
  settingsPage("keyboard", "Keyboard", ["typing", "input"]),
  settingsPage("clipboard", "Clipboard", ["windows clipboard", "copy paste"]),
  settingsPage("printers", "Printers & Scanners", ["printer", "scanner"]),
  settingsPage("dateandtime", "Date & Time", ["clock", "timezone", "time zone"]),
  settingsPage("regionlanguage", "Language & Region", ["language", "region", "locale"]),
  settingsPage("windowsupdate", "Windows Update", ["update", "patches"]),
  settingsPage("privacy", "Privacy & Security", ["privacy", "permissions", "security"]),
  settingsPage("yourinfo", "Accounts", ["account", "user", "profile"]),
  settingsPage("signinoptions", "Sign-in Options", ["password", "pin", "windows hello", "fingerprint"]),
  settingsPage("easeofaccess", "Accessibility", ["ease of access", "narrator", "magnifier", "contrast"]),
  settingsPage("about", "About", ["system info", "pc name", "specs", "windows version"]),
];

function commandEntry(def: CommandDef, matches: number[] = []): Entry {
  return {
    id: def.id,
    title: def.title,
    subtitle: def.subtitle,
    icon: { kind: "glyph", glyph: def.glyph, tint: def.tint, gradient: def.gradient },
    matches,
    primary: { id: "open", title: def.primaryTitle, run: def.run },
    confirm: def.confirm,
    pinId: PIN_COMMAND + def.id,
  };
}

/** A website as a result or a favorite: open it, copy the URL, pin it. */
function websiteEntry(url: string, id: string, title: string): Entry {
  return {
    id,
    title,
    subtitle: "Website",
    icon: { kind: "glyph", glyph: "globe", tint: TINT.web },
    primary: { id: "open", title: "Open in Browser", run: () => api.openUrl(url) },
    actions: [{ id: "copy", title: "Copy URL", keys: ["Ctrl", "Shift", "C"], run: () => copyUrl(url) }],
    pinId: PIN_WEBSITE + url,
  };
}

/** "https://www.github.com/foo/" -> "github.com/foo" */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/**
 * The entry for a pinned command, Settings page or website, or null for pins this
 * version doesn't know (e.g. a command that was removed). Apps are handled by the caller.
 */
export function favoriteEntry(pinId: string): Entry | null {
  if (pinId.startsWith(PIN_COMMAND)) {
    const def = COMMANDS.find((c) => PIN_COMMAND + c.id === pinId);
    return def ? { ...commandEntry(def), id: pinId } : null;
  }
  if (pinId.startsWith(PIN_WEBSITE)) {
    const url = pinId.slice(PIN_WEBSITE.length);
    return /^https?:\/\//i.test(url) ? websiteEntry(url, pinId, shortUrl(url)) : null;
  }
  return null;
}

/**
 * Add the favorite actions (Ctrl+Shift+P to pin, reorder when pinned) to a pinnable
 * built-in entry. Apps get theirs from actions.ts instead.
 */
export function withPinActions(entry: Entry, pinned: boolean): Entry {
  const pinId = entry.pinId;
  if (!pinId || entry.app) return entry;
  const actions: EntryAction[] = [
    ...(entry.actions ?? []),
    {
      id: "pin",
      title: pinned ? "Remove from Favorites" : "Add to Favorites",
      keys: ["Ctrl", "Shift", "P"],
      run: (c) => c.togglePin(pinId, entry.title),
    },
  ];
  if (pinned) {
    actions.push(
      { id: "pin-up", title: "Move Up in Favorites", keys: ["Ctrl", "Shift", "↑"], run: (c) => c.movePin(pinId, -1) },
      { id: "pin-down", title: "Move Down in Favorites", keys: ["Ctrl", "Shift", "↓"], run: (c) => c.movePin(pinId, 1) },
    );
  }
  return { ...entry, actions, pinned };
}

/** Matching commands, best first, plus the best score (for ordering against apps). */
export function matchCommands(query: string): { entries: Entry[]; best: number } {
  const hits = COMMANDS.flatMap((def) => {
    const m = fuzzyMatch(query, def.title, def.keywords);
    return m ? [{ def, m }] : [];
  }).sort((a, b) => b.m.score - a.m.score);
  return {
    entries: hits.slice(0, 8).map(({ def, m }) => commandEntry(def, m.matches)),
    best: hits[0]?.m.score ?? 0,
  };
}

// ---------- web search ----------

interface Site {
  name: string;
  url: string;
}

export const ENGINES: Record<SearchEngine, Site> = {
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
};

/** Type `yt cats` to search YouTube directly. */
export const PREFIXES: Record<string, Site> = {
  g: ENGINES.google,
  ddg: ENGINES.duckduckgo,
  b: ENGINES.bing,
  yt: { name: "YouTube", url: "https://www.youtube.com/results?search_query=" },
  gh: { name: "GitHub", url: "https://github.com/search?q=" },
  w: { name: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=" },
  npm: { name: "npm", url: "https://www.npmjs.com/search?q=" },
  maps: { name: "Google Maps", url: "https://www.google.com/maps/search/" },
};

function webSearchEntry(site: Site, term: string): Entry {
  const url = site.url + encodeURIComponent(term);
  return {
    id: `web:${site.name}:${term}`,
    title: `Search ${site.name} for “${term}”`,
    subtitle: "Web Search",
    icon: { kind: "glyph", glyph: "search", tint: TINT.web },
    primary: { id: "open", title: "Search", run: () => api.openUrl(url) },
    actions: [{ id: "copy", title: "Copy Search URL", keys: ["Ctrl", "Shift", "C"], run: () => copyUrl(url) }],
  };
}

const copyUrl = (url: string) => copyText(url).then(() => "Copied URL");

/** "Search Google for …" (default engine first), shown at the bottom of every search. */
export function webFallbacks(query: string, engine: SearchEngine): Entry[] {
  const term = query.trim();
  if (!term) return [];
  const second: SearchEngine = engine === "google" ? "duckduckgo" : "google";
  return [webSearchEntry(ENGINES[engine], term), webSearchEntry(ENGINES[second], term)];
}

// ---------- URLs and paths ----------

// Domains that are unambiguous as typed. Country codes that double as file extensions
// (.rs, .sh, .so, .to, .it, .in, .me, .md…) are left out so `main.rs` isn't a "website";
// those still work with www., a scheme or a path.
const TLDS = new Set(
  ("com org net io dev app co ai gov edu uk ca de fr jp au nl se no es ch " +
    "xyz info biz tech site page cloud blog news shop store")
    .split(" "),
);

/** `github.com/foo` -> `https://github.com/foo`; null unless it really looks like a URL. */
export function asUrl(query: string): string | null {
  const s = query.trim();
  if (!s || /\s/.test(s) || s.length > 2048) return null;
  if (/^https?:\/\/[^\s/$.?#].\S*$/i.test(s)) return s;
  const m = /^(localhost|(?:[a-z0-9-]+\.)+([a-z]{2,}))(:\d{1,5})?([/?#]\S*)?$/i.exec(s);
  if (!m) return null;
  if (m[1].toLowerCase() === "localhost") return m[3] || m[4] ? `http://${s}` : null;
  if (!TLDS.has(m[2].toLowerCase()) && !/^www\./i.test(s) && !m[4]?.startsWith("/")) return null;
  return `https://${s}`;
}

/** Cheap check before asking Rust whether the path exists. */
export function looksLikePath(query: string): boolean {
  return /^"?([a-z]:[\\/]|\\\\|~([\\/]|$)|%[a-z_][a-z0-9_]*%)/i.test(query.trim());
}

// ---------- "quick" results shown above everything else ----------

export function quickEntries(query: string, path: PathInfo | null): Entry[] {
  const out: Entry[] = [];
  const q = query.trim();

  const prefixed = /^(\S+)\s+(.+)$/.exec(q);
  const site = prefixed && PREFIXES[prefixed[1].toLowerCase()];
  if (site && prefixed) out.push(webSearchEntry(site, prefixed[2]));

  const calc = calculate(q);
  if (calc) {
    out.push({
      id: "calc",
      title: calc.display,
      prefix: `${calc.expression} =`,
      subtitle: "Calculator",
      icon: { kind: "glyph", glyph: "calculator", tint: TINT.calc },
      primary: { id: "copy", title: "Copy Answer", run: () => copyText(calc.copy).then(() => `Copied ${calc.copy}`) },
    });
  }

  if (/^(#|rgba?\(|hsla?\()/i.test(q)) {
    const color = parseColor(q);
    if (color) {
      const hex = toHex(color);
      const copy = (v: string) => () => copyText(v).then(() => `Copied ${v}`);
      out.push({
        id: "color",
        title: hex,
        subtitle: "Color",
        icon: { kind: "swatch", color: hex },
        primary: { id: "copy-hex", title: "Copy HEX", run: copy(hex) },
        actions: [
          { id: "copy-rgb", title: `Copy ${toRgbString(color)}`, run: copy(toRgbString(color)) },
          { id: "copy-hsl", title: `Copy ${toHslString(color)}`, run: copy(toHslString(color)) },
          { id: "picker", title: "Open in Color Picker", run: (c) => c.openView("color", hex) },
        ],
      });
    }
  }

  const url = asUrl(q);
  if (url) out.push(websiteEntry(url, "url", `Open ${url.replace(/^https?:\/\//i, "")}`));

  if (path) {
    out.push({
      id: "path",
      title: path.path,
      subtitle: path.isDir ? "Folder" : "File",
      icon: { kind: "glyph", glyph: path.isDir ? "folder" : "file", tint: TINT.file },
      primary: { id: "open", title: path.isDir ? "Open Folder" : "Open File", run: () => api.openPath(path.path) },
      actions: [
        { id: "reveal", title: "Show in File Explorer", keys: ["Ctrl", "↵"], run: () => api.openPath(path.path, true) },
        {
          id: "copy",
          title: "Copy Path",
          keys: ["Ctrl", "Shift", "C"],
          run: () => copyText(path.path).then(() => "Copied path to clipboard"),
        },
      ],
    });
  }

  return out;
}
