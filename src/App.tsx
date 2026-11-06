import { Command } from "cmdk";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionPanel, type PanelAction } from "./components/ActionPanel";
import { ColorView } from "./components/ColorView";
import { EntryIconView, GEAR_PATH } from "./components/EntryIconView";
import { Kbd } from "./components/Kbd";
import { SettingsView } from "./components/SettingsView";
import { WelcomeView } from "./components/WelcomeView";
import { actionFromKey, actionsFor, type ActionId } from "./lib/actions";
import {
  appEntry,
  looksLikePath,
  matchCommands,
  quickEntries,
  webFallbacks,
  type Ctx,
  type Entry,
  type View,
} from "./lib/entries";
import {
  api,
  applyTheme,
  errorMessage,
  events,
  on,
  type Home,
  type Item,
  type PathInfo,
  type Settings,
  type UpdateInfo,
} from "./lib/ipc";

// The emoji data is ~300 KB; only load it when the picker is opened.
const EmojiView = lazy(() => import("./components/EmojiView"));

const DEV = import.meta.env.DEV;

interface Section {
  key: string;
  title: string;
  entries: Entry[];
}

interface Results {
  query: string;
  items: Item[];
  path: PathInfo | null;
}

interface Toast {
  text: string;
  error?: boolean;
  ms?: number;
  /** A "press ↵ again" prompt; cleared when the confirmation lapses. */
  confirm?: boolean;
}

interface DevAction extends PanelAction {
  run: () => void;
}

const valueOf = (section: string, id: string) => `${section}:${id}`;

export function App() {
  const [view, setView] = useState<View>("root");
  const [viewArg, setViewArg] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [home, setHome] = useState<Home | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [selected, setSelected] = useState("");
  const [panel, setPanel] = useState<"actions" | "dev" | null>(null);
  /** Where a right-click opened the actions menu; null = above the footer (Ctrl+K). */
  const [panelAnchor, setPanelAnchor] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  /** How the current screen arrived, which picks its entrance animation. */
  const [nav, setNav] = useState<"forward" | "back" | "intro" | "none">("none");
  const launcherRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const selectFirst = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  const showToast = useCallback((text: string, error = false, ms?: number) => setToast({ text, error, ms }), []);
  const showError = useCallback((e: unknown) => showToast(errorMessage(e), true), [showToast]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms ?? (toast.error ? 4000 : 1800));
    return () => clearTimeout(t);
  }, [toast]);

  const focusInput = useCallback(() => requestAnimationFrame(() => inputRef.current?.focus()), []);

  const openView = useCallback((next: View, arg?: string) => {
    setPanel(null);
    setViewArg(arg);
    setNav(next === "welcome" ? "intro" : "forward");
    setView(next);
  }, []);

  // Hide the animated parts while the window is hidden, so the first frame Windows shows on
  // the next open is already the start of the entrance (otherwise the old, fully drawn
  // frame flashes before the animation resets it, which looks like a flicker).
  const primeEnter = useCallback(() => {
    const el = launcherRef.current;
    if (!el) return;
    window.clearTimeout(enterTimer.current);
    el.classList.remove("launcher--enter");
    el.classList.add("launcher--primed");
  }, []);

  // Replay the "open" entrance each time the window is shown (it's never recreated).
  const playEnter = useCallback(() => {
    const el = launcherRef.current;
    if (!el) return;
    el.classList.remove("launcher--primed");
    el.classList.remove("launcher--enter");
    void el.offsetWidth; // restart the CSS animations
    el.classList.add("launcher--enter");
    window.clearTimeout(enterTimer.current);
    enterTimer.current = window.setTimeout(() => el.classList.remove("launcher--enter"), 700);
  }, []);

  const loadHome = useCallback(() => {
    api.getHome().then(setHome).catch(showError);
  }, [showError]);

  /** Reload settings; shows the welcome screen until the user has finished it once. */
  const loadSettings = useCallback(
    (checkOnboarding = false) => {
      api
        .getSettings()
        .then((s) => {
          setSettings(s);
          applyTheme(s.theme);
          if (checkOnboarding && !s.onboarded) openView("welcome");
        })
        .catch(showError);
    },
    [openView, showError],
  );

  // Latest-request-wins search: stale responses are dropped.
  const runSearch = useCallback(
    (q: string, fresh: boolean) => {
      const seq = ++searchSeq.current;
      if (!q.trim()) {
        setResults(null);
        return;
      }
      const path = looksLikePath(q) ? api.checkPath(q).catch(() => null) : Promise.resolve(null);
      Promise.all([api.search(q), path])
        .then(([items, pathInfo]) => {
          if (seq !== searchSeq.current) return;
          if (fresh) selectFirst.current = true;
          setResults({ query: q, items, path: pathInfo });
        })
        .catch(showError);
    },
    [showError],
  );

  useEffect(() => runSearch(query, true), [query, runSearch]);

  const refresh = useCallback(() => {
    loadHome();
    if (queryRef.current.trim()) runSearch(queryRef.current, false);
  }, [loadHome, runSearch]);

  // Backend events.
  useEffect(() => {
    loadHome();
    loadSettings(true);
    playEnter();
    const offs = [
      on(events.shown, () => {
        loadHome();
        loadSettings(true);
        focusInput();
        playEnter();
      }),
      on(events.hidden, () => {
        // Reset while hidden so the next open starts clean without flicker.
        setQuery("");
        setResults(null);
        setPanel(null);
        setConfirming(null);
        setNav("none");
        setView("root");
        primeEnter();
        listRef.current?.scrollTo({ top: 0 });
      }),
      on(events.appsChanged, refresh),
      on(events.openSettings, () => openView("settings")),
      on<UpdateInfo>(events.updateAvailable, setUpdate),
    ];
    return () => offs.forEach((off) => off());
  }, [loadHome, loadSettings, refresh, focusInput, openView, playEnter, primeEnter]);

  const sections: Section[] = useMemo(() => {
    if (results) {
      const q = results.query;
      const quick = quickEntries(q, results.path);
      const commands = matchCommands(q);
      const apps: Section = { key: "res", title: "Applications", entries: results.items.map(appEntry) };
      const cmds: Section = { key: "cmd", title: "Commands", entries: commands.entries };
      // A strong command match ("lock", "wifi") beats apps that only match loosely.
      const lower = q.trim().toLowerCase();
      const appPrefix = results.items.some((i) => i.name.toLowerCase().startsWith(lower));
      const middle = commands.best >= 68 && !appPrefix ? [cmds, apps] : [apps, cmds];
      return [
        { key: "top", title: quick.length > 1 ? "Top Results" : "Top Result", entries: quick },
        ...middle,
        { key: "web", title: `Use “${q.trim()}” with…`, entries: webFallbacks(q, settings?.searchEngine ?? "google") },
      ].filter((s) => s.entries.length > 0);
    }
    if (!home) return [];
    return [
      { key: "fav", title: "Favorites", entries: home.favorites.map(appEntry) },
      { key: "sug", title: "Suggestions", entries: home.suggestions.map(appEntry) },
      { key: "app", title: "Applications", entries: home.applications.map(appEntry) },
    ].filter((s) => s.entries.length > 0);
  }, [home, results, settings?.searchEngine]);

  const byValue = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const s of sections) for (const entry of s.entries) map.set(valueOf(s.key, entry.id), entry);
    return map;
  }, [sections]);

  // New search -> select the first result; otherwise keep the selection on something that exists.
  useEffect(() => {
    if (selectFirst.current || !byValue.has(selected)) {
      selectFirst.current = false;
      const first = byValue.keys().next();
      setSelected(first.done ? "" : first.value);
    }
  }, [byValue, selected]);

  // A pending "press ↵ again" only applies to the item it was asked for, and expires.
  useEffect(() => setConfirming(null), [selected]);
  useEffect(() => {
    if (!confirming) {
      // Don't leave "Press ↵ again…" on screen once it no longer applies.
      setToast((t) => (t?.confirm ? null : t));
      return;
    }
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const current = byValue.get(selected) ?? null;

  const checkForUpdates = useCallback(() => {
    showToast("Checking for updates…");
    api
      .checkForUpdate()
      .then((found) => {
        setUpdate(found);
        showToast(found ? `Fyn ${found.version} is available. Open Settings to install` : "Fyn is up to date");
      })
      .catch(showError);
  }, [showError, showToast]);

  const ctx: Ctx = useMemo(() => ({ openView, checkForUpdates }), [openView, checkForUpdates]);

  const runAppAction = useCallback(
    async (action: ActionId, item: Item) => {
      switch (action) {
        case "open":
          await api.launch(item.id);
          break;
        case "admin":
          if (item.canRunAsAdmin) await api.launch(item.id, true);
          break;
        case "reveal":
          await api.reveal(item.id);
          break;
        case "pin": {
          const pinned = await api.togglePin(item.id);
          showToast(pinned ? `Added ${item.name} to Favorites` : `Removed ${item.name} from Favorites`);
          refresh();
          break;
        }
        case "pin-up":
        case "pin-down":
          if (item.pinned) {
            await api.movePin(item.id, action === "pin-up" ? -1 : 1);
            refresh();
          }
          break;
        case "copy":
          await navigator.clipboard.writeText(item.path);
          showToast("Copied path to clipboard");
          break;
      }
    },
    [refresh, showToast],
  );

  const runEntry = useCallback(
    async (entry: Entry | null, actionId?: string) => {
      setPanel(null);
      focusInput();
      if (!entry) return;
      try {
        if (entry.app) {
          await runAppAction((actionId ?? "open") as ActionId, entry.app);
          return;
        }
        const action =
          !actionId || actionId === entry.primary.id ? entry.primary : entry.actions?.find((a) => a.id === actionId);
        if (!action) return;
        if (entry.confirm && action === entry.primary && confirming !== entry.id) {
          setConfirming(entry.id);
          setToast({ text: `Press ↵ again to ${entry.confirm}`, ms: 4000, confirm: true });
          return;
        }
        setConfirming(null);
        const message = await action.run(ctx);
        if (typeof message === "string" && message) showToast(message);
      } catch (e) {
        showError(e);
      }
    },
    [confirming, ctx, focusInput, runAppAction, showError, showToast],
  );

  const panelActions: PanelAction[] = useMemo(() => {
    if (!current) return [];
    if (current.app) return actionsFor(current.app);
    return [{ ...current.primary, keys: ["↵"] }, ...(current.actions ?? [])];
  }, [current]);

  const devActions: DevAction[] = useMemo(
    () => [
      { id: "welcome", title: "Show Welcome Screen", run: () => openView("welcome") },
      { id: "settings", title: "Show Settings", run: () => openView("settings") },
      { id: "emoji", title: "Show Emoji Picker", run: () => openView("emoji") },
      { id: "color", title: "Show Color Picker", run: () => openView("color", "#7C3AED") },
      {
        id: "update",
        title: "Simulate Update Available",
        run: () =>
          setUpdate({ version: "9.9.9", currentVersion: settings?.version ?? "0.0.0", notes: "Simulated from the dev menu" }),
      },
      { id: "update-clear", title: "Clear Update Notice", run: () => setUpdate(null) },
      { id: "toast", title: "Show Toast", run: () => showToast("This is what a toast looks like") },
      { id: "toast-error", title: "Show Error Toast", run: () => showToast("Something went wrong (example)", true) },
      {
        id: "onboarding",
        title: "Reset Onboarding",
        run: () =>
          void api
            .setOnboarded(false)
            .then(() => showToast("The welcome screen will show the next time Fyn opens"))
            .catch(showError),
      },
      { id: "reload", title: "Reload UI", run: () => location.reload() },
    ],
    [openView, settings?.version, showError, showToast],
  );

  // Dev menu: Ctrl+Shift+D from any screen (dev builds only).
  useEffect(() => {
    if (!DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        // Only animates if we were on another screen (same key = no remount).
        setNav("back");
        setView("root");
        setPanel((p) => (p === "dev" ? null : "dev"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const back = useCallback(() => {
    setNav("back");
    setView("root");
    loadSettings();
    focusInput();
  }, [focusInput, loadSettings]);

  const finishWelcome = useCallback(() => {
    api.setOnboarded(true).catch(showError);
    setSettings((s) => (s ? { ...s, onboarded: true } : s));
    back();
  }, [back, showError]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (panelActions.length > 1) {
        setPanelAnchor(null);
        setPanel((p) => (p === "actions" ? null : "actions"));
      }
      return;
    }
    if (ctrl && e.key === ",") {
      e.preventDefault();
      openView("settings");
      return;
    }
    // Ctrl+1…9 opens the matching favorite.
    if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key) && !results && home) {
      const fav = home.favorites[Number(e.key) - 1];
      if (fav) {
        e.preventDefault();
        void runEntry(appEntry(fav));
      }
      return;
    }
    const action = actionFromKey(e);
    if (action && current && (current.app || current.actions?.some((a) => a.id === action))) {
      e.preventDefault();
      void runEntry(current, action);
      return;
    }
    // Ctrl(+Shift)+Enter on something without that action must not fall through to
    // cmdk's plain-Enter handling (e.g. "run as admin" silently doing a normal open).
    if (action && e.key === "Enter") {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else void api.hide();
    }
  };

  // The panel (and its acrylic surface) stays put; only the screen inside it changes,
  // keyed by view so each new screen plays its entrance.
  return (
    <div className="launcher" ref={launcherRef}>
      <div key={view} className={`screen screen--${nav}`}>
        {view === "settings" ? (
          <SettingsView
            onBack={back}
            onShowWelcome={() => openView("welcome")}
            update={update}
            onUpdate={setUpdate}
          />
        ) : view === "welcome" ? (
          <WelcomeView
            settings={settings}
            onDone={finishWelcome}
            onChangeHotkey={() => {
              finishWelcome();
              openView("settings");
            }}
          />
        ) : view === "emoji" ? (
          <Suspense fallback={null}>
            <EmojiView onBack={back} />
          </Suspense>
        ) : view === "color" ? (
          <ColorView initial={viewArg} onBack={back} />
        ) : (
          renderRoot()
        )}
      </div>
    </div>
  );

  function renderRoot() {
    const confirmingCurrent = current && confirming === current.id;

    return (
      <>
        <Command
          className="cmdk"
          label="Fyn"
          shouldFilter={false}
          loop
          value={selected}
          onValueChange={setSelected}
          onKeyDown={onKeyDown}
        >
          <div className="search">
            <SearchIcon />
            <Command.Input
              ref={inputRef}
              className="search__input"
              value={query}
              onValueChange={setQuery}
              placeholder="Search apps, commands, or do math…"
              autoFocus
              spellCheck={false}
              maxLength={256}
            />
          </div>

          <Command.List ref={listRef} className="list">
            {home && <Command.Empty className="empty">No results for “{query}”</Command.Empty>}
            {sections.map((s, i) => (
              <Command.Group
                key={s.key}
                heading={s.title}
                className="group"
                style={{ "--g": i } as React.CSSProperties}
              >
                {s.entries.map((entry) => (
                  <Row
                    key={entry.id}
                    value={valueOf(s.key, entry.id)}
                    entry={entry}
                    onRun={() => void runEntry(entry)}
                    onContextMenu={(e) => {
                      // Right-click: select the row and open its actions at the pointer.
                      e.preventDefault();
                      setSelected(valueOf(s.key, entry.id));
                      setPanelAnchor({ x: e.clientX, y: e.clientY });
                      setPanel("actions");
                    }}
                  />
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>

        <footer className="footer">
          <div className="footer__left">
            {toast ? (
              <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>
            ) : (
              <>
                <button
                  className="icon-btn"
                  aria-label="Settings"
                  title="Settings (Ctrl+,)"
                  onClick={() => openView("settings")}
                >
                  <GearIcon />
                </button>
                {update && (
                  <button className="pill" onClick={() => openView("settings")} title="Open Settings to install">
                    Update {update.version} available
                  </button>
                )}
                {DEV && (
                  <button className="pill pill--dev" onClick={() => setPanel("dev")} title="Developer menu (Ctrl+Shift+D)">
                    DEV
                  </button>
                )}
              </>
            )}
          </div>
          {current && (
            <div className="footer__right">
              <button className="footer__action" onClick={() => void runEntry(current)}>
                {confirmingCurrent ? "Press ↵ to Confirm" : current.primary.title} <Kbd keys={["↵"]} />
              </button>
              {panelActions.length > 1 && (
                <>
                  <span className="footer__divider" />
                  <button
                    className="footer__action"
                    onClick={() => {
                      setPanelAnchor(null);
                      setPanel((p) => (p === "actions" ? null : "actions"));
                    }}
                  >
                    Actions <Kbd keys={["Ctrl", "K"]} />
                  </button>
                </>
              )}
            </div>
          )}
        </footer>

        {panel === "actions" && current && (
          <ActionPanel
            title={current.title}
            actions={panelActions}
            anchor={panelAnchor}
            onRun={(id) => void runEntry(current, id)}
            onClose={() => {
              setPanel(null);
              focusInput();
            }}
          />
        )}

        {DEV && panel === "dev" && (
          <ActionPanel
            title="Developer: open a screen or state"
            placeholder="Search dev actions…"
            actions={devActions}
            onRun={(id) => {
              setPanel(null);
              devActions.find((a) => a.id === id)?.run();
              focusInput();
            }}
            onClose={() => {
              setPanel(null);
              focusInput();
            }}
          />
        )}
      </>
    );
  }
}

interface RowProps {
  entry: Entry;
  value: string;
  onRun: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const Row = memo(function Row({ entry, value, onRun, onContextMenu }: RowProps) {
  return (
    <Command.Item value={value} className="row" onSelect={onRun} onContextMenu={onContextMenu}>
      <EntryIconView icon={entry.icon} />
      <span className="row__name">
        {entry.prefix && <span className="row__prefix">{entry.prefix} </span>}
        <Highlight text={entry.title} matches={entry.matches ?? []} />
      </span>
      {entry.app?.pinned && (
        <span className="row__pin" title="Favorite">
          ★
        </span>
      )}
      <span className="row__kind">{entry.subtitle}</span>
      <OpenIcon />
    </Command.Item>
  );
});

/** Bold the characters the fuzzy matcher hit, grouping consecutive runs. */
function Highlight({ text, matches }: { text: string; matches: number[] }) {
  if (matches.length === 0) return <>{text}</>;
  const hit = new Set(matches);
  const chars = Array.from(text);
  const parts: { s: string; m: boolean }[] = [];
  chars.forEach((ch, i) => {
    const m = hit.has(i);
    const last = parts[parts.length - 1];
    if (last && last.m === m) last.s += ch;
    else parts.push({ s: ch, m });
  });
  return (
    <>
      {parts.map((p, i) => (p.m ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}
    </>
  );
}

function SearchIcon() {
  return (
    <svg className="search__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg className="row__open" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M5 11l6-6M6 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={GEAR_PATH} />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
