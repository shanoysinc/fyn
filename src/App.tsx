import { Command } from "cmdk";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActionPanel, type PanelAction } from "./components/ActionPanel";
import { ColorView } from "./components/ColorView";
import { EntryIconView, GEAR_PATH } from "./components/EntryIconView";
import { Kbd } from "./components/Kbd";
import { SettingsView } from "./components/SettingsView";
import { BackButton } from "./components/ViewHeader";
import { WelcomeView } from "./components/WelcomeView";
import { actionFromKey, actionsFor, type ActionId } from "./lib/actions";
import { fuzzyMatch } from "./lib/fuzzy";
import { gridMove, type ArrowKey } from "./lib/gridNav";
import {
  appEntry,
  favoriteEntry,
  looksLikePath,
  matchCommands,
  withPinActions,
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

/** Icons per row in the Favorites / Suggestions grid (the window is a fixed 750px wide). */
const TILE_COLUMNS = 8;
/** Rows of Favorites / Suggestions on the home screen before "View all" takes over. */
const HOME_ROWS = 3;

const COLLECTION_TITLE: Record<string, string> = { fav: "Favorites", sug: "Suggestions" };

interface Section {
  key: string;
  title: string;
  entries: Entry[];
  /** Shown as a grid of icons instead of a list. */
  tiles?: boolean;
  /** More items than fit on the home screen: show "View all" in the heading. */
  viewAll?: { key: "fav" | "sug"; total: number };
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
  const viewRef = useRef(view);
  viewRef.current = view;
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
    // Home ↔ "View all" share the same screen (search bar + list + footer): only the
    // list content changes, so no screen slide; see the list swap animation below.
    setNav(next === "welcome" ? "intro" : next === "collection" && viewRef.current === "root" ? "none" : "forward");
    if (next === "collection") setQuery(""); // the box filters the collection from scratch
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

  // The "View all" screen filters locally; everywhere else the box searches everything.
  useEffect(() => runSearch(view === "collection" ? "" : query, true), [query, runSearch, view]);

  const refresh = useCallback(() => {
    loadHome();
    if (queryRef.current.trim()) runSearch(queryRef.current, false);
  }, [loadHome, runSearch]);

  // Backend events.
  useEffect(() => {
    loadHome();
    loadSettings(true);
    // Start hidden; the entrance plays once the list exists and the window is on screen.
    primeEnter();
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

  // First load: once apps and settings are in and that frame is painted (still hidden),
  // tell the backend. On a manual start it shows the window now, and the "shown" event
  // plays the entrance with the whole list already in place: no empty panel, no rows
  // popping in mid-animation.
  const readySent = useRef(false);
  useEffect(() => {
    if (readySent.current || !home || !settings) return;
    readySent.current = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        api
          .uiReady()
          .then((state) => {
            if (state === "visible") playEnter(); // e.g. a dev reload: no "shown" event comes
          })
          .catch(() => playEnter());
      }),
    );
  }, [home, settings, playEnter]);

  // Favorites in pin order: installed apps plus pinned commands, Settings pages and
  // websites. Pins for apps that were uninstalled (or unknown commands) are skipped.
  const favorites: Entry[] = useMemo(() => {
    if (!home) return [];
    const apps = new Map(home.favorites.map((a) => [a.id, a]));
    return home.pins.flatMap((id) => {
      const app = apps.get(id);
      const entry = app ? appEntry(app) : favoriteEntry(id);
      return entry ? [entry] : [];
    });
  }, [home]);
  const pinnedIds = useMemo(() => new Set(home?.pins ?? []), [home]);

  const sections: Section[] = useMemo(() => {
    // Built-in entries get "Add to / Remove from Favorites" (apps have theirs already).
    const withPins = (s: Section): Section => ({
      ...s,
      entries: s.entries.map((e) => withPinActions(e, !!e.pinId && pinnedIds.has(e.pinId))),
    });
    return buildSections().map(withPins);
  }, [home, results, favorites, pinnedIds, view, viewArg, query, settings?.searchEngine, settings?.homeLayout]); // eslint-disable-line react-hooks/exhaustive-deps

  function buildSections(): Section[] {
    const tiles = (settings?.homeLayout ?? "grid") === "grid";

    // "View all" screen: every favorite or suggestion, filtered by the search box.
    if (view === "collection") {
      const all = viewArg === "sug" ? (home?.suggestions ?? []).map(appEntry) : favorites;
      const q = query.trim();
      const entries = q
        ? all.flatMap((e) => {
            const m = fuzzyMatch(q, e.title);
            return m ? [{ ...e, matches: m.matches }] : [];
          })
        : all;
      return entries.length ? [{ key: `all-${viewArg}`, title: COLLECTION_TITLE[viewArg ?? "fav"], entries, tiles }] : [];
    }

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
    // Home: at most 3 rows of icons (or 3 list items); the rest is behind "View all".
    const limit = tiles ? TILE_COLUMNS * HOME_ROWS : HOME_ROWS;
    const capped = (key: "fav" | "sug", title: string, all: Entry[]): Section => ({
      key,
      title,
      tiles,
      entries: all.slice(0, limit),
      viewAll: all.length > limit ? { key, total: all.length } : undefined,
    });
    return [
      capped("fav", "Favorites", favorites),
      capped("sug", "Suggestions", home.suggestions.map(appEntry)),
      { key: "app", title: "Applications", entries: home.applications.map(appEntry) },
    ].filter((s) => s.entries.length > 0);
  }

  // Visual rows for arrow keys: icons wrap into rows of TILE_COLUMNS; every list item is
  // its own row.
  const gridRows = useMemo(() => {
    if (!sections.some((s) => s.tiles)) return null;
    return sections.flatMap((s) => {
      const values = s.entries.map((e) => valueOf(s.key, e.id));
      if (!s.tiles) return values.map((v) => [v]);
      const rows: string[][] = [];
      for (let i = 0; i < values.length; i += TILE_COLUMNS) rows.push(values.slice(i, i + TILE_COLUMNS));
      return rows;
    });
  }, [sections]);
  const gridColumn = useRef(0);

  // Home ↔ "View all": the search bar and footer stay put while the list content fades
  // and rises in (applied before paint so the new items never flash in unanimated).
  const prevView = useRef(view);
  useLayoutEffect(() => {
    const from = prevView.current;
    prevView.current = view;
    const swap = (from === "root" && view === "collection") || (from === "collection" && view === "root");
    const el = listRef.current;
    if (!swap || !el) return;
    el.scrollTop = 0;
    el.classList.remove("list--swap");
    void el.offsetWidth; // restart the animation
    el.classList.add("list--swap");
    const t = window.setTimeout(() => el.classList.remove("list--swap"), 500);
    return () => window.clearTimeout(t);
  }, [view]);

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

  const ctx: Ctx = useMemo(
    () => ({
      openView,
      checkForUpdates,
      togglePin: async (pinId, title) => {
        const pinned = await api.togglePin(pinId);
        refresh();
        return pinned ? `Added ${title} to Favorites` : `Removed ${title} from Favorites`;
      },
      movePin: async (pinId, delta) => {
        await api.movePin(pinId, delta);
        refresh();
      },
    }),
    [openView, checkForUpdates, refresh],
  );

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
    setNav(viewRef.current === "collection" ? "none" : "back"); // see openView
    setView("root");
    setQuery(""); // e.g. the "View all" filter text means nothing on the home screen
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

    // Icon rows: arrows move left/right along a row and up/down between rows.
    // (Only on the home screen, where the search box is empty, so the caret isn't needed.)
    if (gridRows && !ctrl && !e.shiftKey && !e.altKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      const move = gridMove(gridRows, selected, e.key as ArrowKey, gridColumn.current);
      if (move) {
        e.preventDefault();
        gridColumn.current = move.column;
        setSelected(move.value);
        // Bring it into view, including sideways in a long Favorites row.
        requestAnimationFrame(() =>
          listRef.current
            ?.querySelector(`[cmdk-item][data-value="${CSS.escape(move.value)}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
        );
        return;
      }
    }

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
      const fav = favorites[Number(e.key) - 1];
      if (fav) {
        e.preventDefault();
        void runEntry(fav);
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
      else if (view === "collection") back();
      else void api.hide();
    }
  };

  // The panel (and its acrylic surface) stays put; only the screen inside it changes,
  // keyed by view so each new screen plays its entrance.
  return (
    <div className="launcher" ref={launcherRef}>
      {/* Home and "View all" are one screen (same key): only their list content swaps. */}
      <div key={view === "collection" ? "root" : view} className={`screen screen--${nav}`}>
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
            {view === "collection" ? <BackButton onBack={back} /> : <SearchIcon />}
            <Command.Input
              ref={inputRef}
              className="search__input"
              value={query}
              onValueChange={setQuery}
              placeholder={
                view === "collection"
                  ? `Filter ${COLLECTION_TITLE[viewArg ?? "fav"].toLowerCase()}…`
                  : "Search apps, commands, or do math…"
              }
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
                heading={
                  s.viewAll ? (
                    <>
                      <span className="group__title">{s.title}</span>
                      <button
                        className="view-all"
                        onMouseDown={(e) => e.preventDefault()} // keep focus in the search box
                        onClick={() => openView("collection", s.viewAll!.key)}
                        title={`See all ${s.viewAll.total}`}
                      >
                        View all {s.viewAll.total}
                        <ChevronRight />
                      </button>
                    </>
                  ) : (
                    s.title
                  )
                }
                className={`group ${s.tiles ? "group--tiles" : ""}`}
                style={{ "--g": i } as React.CSSProperties}
              >
                {s.entries.map((entry) => {
                  const value = valueOf(s.key, entry.id);
                  const onContextMenu = (e: React.MouseEvent) => {
                    // Right-click: select the item and open its actions at the pointer.
                    e.preventDefault();
                    setSelected(value);
                    setPanelAnchor({ x: e.clientX, y: e.clientY });
                    setPanel("actions");
                  };
                  return s.tiles ? (
                    <Tile
                      key={entry.id}
                      value={value}
                      entry={entry}
                      onRun={() => void runEntry(entry)}
                      onContextMenu={onContextMenu}
                    />
                  ) : (
                    <Row
                      key={entry.id}
                      value={value}
                      entry={entry}
                      onRun={() => void runEntry(entry)}
                      // Everything in Favorites is a favorite; the star only adds noise there.
                      showStar={s.key !== "fav"}
                      onContextMenu={onContextMenu}
                    />
                  );
                })}
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
  showStar: boolean;
}

const Row = memo(function Row({ entry, value, onRun, onContextMenu, showStar }: RowProps) {
  return (
    <Command.Item value={value} className="row" onSelect={onRun} onContextMenu={onContextMenu}>
      <EntryIconView icon={entry.icon} />
      <span className="row__name">
        {entry.prefix && <span className="row__prefix">{entry.prefix} </span>}
        <Highlight text={entry.title} matches={entry.matches ?? []} />
      </span>
      {showStar && (entry.app?.pinned || entry.pinned) && (
        <span className="row__pin" title="Favorite" aria-label="Favorite">
          <StarIcon />
        </span>
      )}
      <span className="row__kind">{entry.subtitle}</span>
      <OpenIcon />
    </Command.Item>
  );
});

/** An app in a horizontal icon row (Favorites / Suggestions in the "grid" layout). */
const Tile = memo(function Tile({ entry, value, onRun, onContextMenu }: Omit<RowProps, "showStar">) {
  return (
    <Command.Item value={value} className="tile" onSelect={onRun} onContextMenu={onContextMenu} title={entry.title}>
      <span className="tile__icon">
        <EntryIconView icon={entry.icon} />
      </span>
      <span className="tile__name">{entry.title}</span>
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

/** Rounded five-point star for favorites (filled, with a soft outline for contrast). */
function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        d="M11.1 2.9a1 1 0 0 1 1.8 0l2.4 4.9 5.4.8a1 1 0 0 1 .6 1.7l-3.9 3.8.9 5.4a1 1 0 0 1-1.5 1l-4.8-2.5-4.8 2.5a1 1 0 0 1-1.5-1l.9-5.4-3.9-3.8a1 1 0 0 1 .6-1.7l5.4-.8Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
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

function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
