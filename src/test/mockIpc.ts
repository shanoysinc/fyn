// A fake Tauri backend for component tests. Use with:
//   vi.mock("<path>/lib/ipc", async (orig) => mockIpcModule(await orig()));
import { vi } from "vitest";
import type * as Ipc from "../lib/ipc";
import type { ClipSettings } from "../lib/ipc";
import { makeClipStatus, makeHome, makeScanReport, makeSettings } from "./fixtures";

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export const api = {
  getHome: vi.fn(),
  search: vi.fn(),
  launch: vi.fn(),
  reveal: vi.fn(),
  togglePin: vi.fn(),
  movePin: vi.fn(),
  hide: vi.fn(),
  getSettings: vi.fn(),
  setHotkey: vi.fn(),
  suspendHotkey: vi.fn(),
  setAutostart: vi.fn(),
  rescan: vi.fn(),
  setOnboarded: vi.fn(),
  setSearchEngine: vi.fn(),
  setTheme: vi.fn(),
  setHomeLayout: vi.fn(),
  runSystemCommand: vi.fn(),
  openSettingsPage: vi.fn(),
  openUrl: vi.fn(),
  checkPath: vi.fn(),
  openPath: vi.fn(),
  pickScreenColor: vi.fn(),
  uiReady: vi.fn(),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  clipboardStatus: vi.fn(),
  setClipboardSettings: vi.fn(),
  clipboardList: vi.fn(),
  clipboardImage: vi.fn(),
  clipboardCopy: vi.fn(),
  clipboardPaste: vi.fn(),
  clipboardDelete: vi.fn(),
  clipboardClear: vi.fn(),
  clipboardPause: vi.fn(),
  cleanSettings: vi.fn(),
  setCleanSettings: vi.fn(),
  cleanScan: vi.fn(),
  cleanRun: vi.fn(),
} satisfies Record<keyof typeof Ipc.api, unknown>;

/** Restore every fake to its default answer. Call in beforeEach. */
export function resetApi() {
  handlers.clear();
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue(undefined);
  api.getHome.mockResolvedValue(makeHome());
  api.getSettings.mockResolvedValue(makeSettings());
  api.search.mockResolvedValue([]);
  api.checkPath.mockResolvedValue(null);
  api.togglePin.mockResolvedValue(true);
  api.runSystemCommand.mockResolvedValue(null);
  api.checkForUpdate.mockResolvedValue(null);
  api.setHotkey.mockImplementation(async (h: string) => h);
  api.clipboardStatus.mockResolvedValue(makeClipStatus());
  api.clipboardList.mockResolvedValue([]);
  api.cleanSettings.mockResolvedValue({ enabled: ["temp", "npm", "gradle"], protected: ["beacon", "emr"] });
  api.setCleanSettings.mockImplementation(async (s: { enabled: string[]; protected: string[] }) => s);
  api.cleanScan.mockResolvedValue(makeScanReport());
  api.cleanRun.mockResolvedValue({ freedBytes: 0, deletedFiles: 0, skippedFiles: 0, errors: [] });
  api.setClipboardSettings.mockImplementation(async (s: ClipSettings) => makeClipStatus({ ...s }));
  api.clipboardPause.mockImplementation(async (m: number | null) => makeClipStatus({ paused: m !== null }));
}

/** Simulate a backend event (fyn://shown, fyn://hidden, …). */
export function emit(event: string, payload?: unknown) {
  handlers.get(event)?.forEach((h) => h(payload));
}

export function mockIpcModule(real: typeof Ipc): typeof Ipc {
  return {
    ...real,
    api: api as unknown as typeof Ipc.api,
    on: ((event: string, handler: Handler) => {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(handler);
      return () => set!.delete(handler);
    }) as typeof Ipc.on,
    iconUrl: (path: string) => path,
  };
}

export const clipboard = { writeText: vi.fn(async (_text: string) => {}) };

export function installClipboard() {
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}
