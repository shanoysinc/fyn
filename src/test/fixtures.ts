import type {
  ClipEntry,
  ClipStatus,
  Home,
  Item,
  PomodoroSettings,
  PomodoroStats,
  PomodoroView,
  PortEntry,
  ScanCategory,
  ScanReport,
  Settings,
} from "../lib/ipc";

export function makePort(over: Partial<PortEntry> = {}): PortEntry {
  return {
    port: 3000,
    pid: 4120,
    name: "node.exe",
    path: "C:\\Program Files\\nodejs\\node.exe",
    addresses: ["127.0.0.1"],
    protected: false,
    icon: null,
    ...over,
  };
}

export const POMO_SETTINGS: PomodoroSettings = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
  notify: true,
};

export function makePomodoro(over: Partial<PomodoroView> = {}): PomodoroView {
  return {
    phase: "focus",
    running: false,
    endsAt: null,
    remainingMs: 25 * 60_000,
    durationMs: 25 * 60_000,
    active: false,
    doneInCycle: 0,
    label: null,
    settings: POMO_SETTINGS,
    ...over,
  };
}

export function makePomodoroStats(over: Partial<PomodoroStats> = {}): PomodoroStats {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = Math.floor(midnight.getTime() / 1000);
  const minutes = [50, 0, 100, 75, 25, 125, 50];
  return {
    todayMinutes: 50,
    todaySessions: 2,
    week: minutes.map((m, i) => ({ start: today - (6 - i) * 86_400, minutes: m, sessions: m / 25 })),
    streak: 3,
    totalMinutes: 1250,
    totalSessions: 50,
    bestDayMinutes: 125,
    recent: [
      { started: today + 9 * 3600, ended: today + 9 * 3600 + 1500, focusSecs: 1500, completed: true, label: "Write the report" },
      { started: today + 8 * 3600, ended: today + 8 * 3600 + 600, focusSecs: 600, completed: false, label: null },
    ],
    ...over,
  };
}

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
    sourceIcon: null,
    ...over,
  };
}

/** A 1×1 transparent PNG, as clipboard history sends images to the UI. */
export const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function makeImageClip(over: Partial<ClipEntry> = {}): ClipEntry {
  return makeClip({ kind: "image", text: "", chars: 0, width: 1920, height: 1080, bytes: 2_400_000, thumb: TINY_PNG, source: "snippingtool.exe", ...over });
}

export function makeCategory(over: Partial<ScanCategory> = {}): ScanCategory {
  return {
    id: "npm",
    title: "npm cache",
    description: "Downloaded packages",
    enabled: true,
    optional: false,
    available: true,
    files: 16,
    bytes: 1_300_000,
    items: [],
    ...over,
  };
}

/** What a scan returns: some caches, an empty one, and Android emulators to pick from. */
export function makeScanReport(over: Partial<ScanReport> = {}): ScanReport {
  return {
    categories: [
      makeCategory({ id: "temp", title: "Temporary files", bytes: 200_000, files: 2 }),
      makeCategory({ id: "npm", title: "npm cache", bytes: 1_300_000, files: 16 }),
      makeCategory({ id: "gradle", title: "Gradle caches", bytes: 21_000_000, files: 20 }),
      makeCategory({ id: "yarn", title: "Yarn cache", enabled: false, available: false, bytes: 0, files: 0 }),
      makeCategory({
        id: "avd",
        title: "Android emulators",
        enabled: false,
        optional: true,
        bytes: 0,
        files: 0,
        items: [
          { id: "avd:Pixel_7", name: "Pixel 7", bytes: 4_000_000_000, protected: false, note: "Uses android-34/google_apis/x86_64" },
          { id: "avd:Beacon_Tablet", name: "Beacon Tablet", bytes: 3_000_000_000, protected: true, note: null },
        ],
      }),
    ],
    disk: { free: 28_200_000_000, total: 254_800_000_000 },
    ...over,
  };
}
