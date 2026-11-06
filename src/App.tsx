import { Command } from "cmdk";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionPanel } from "./components/ActionPanel";
import { AppIcon } from "./components/AppIcon";
import { Kbd } from "./components/Kbd";
import { SettingsView } from "./components/SettingsView";
import { actionFromKey, actionsFor, type ActionId } from "./lib/actions";
import { api, errorMessage, events, on, type Home, type Item } from "./lib/ipc";

interface Section {
  key: string;
  title: string;
  items: Item[];
}

interface Toast {
  text: string;
  error?: boolean;
}

const valueOf = (section: string, id: string) => `${section}:${id}`;

export function App() {
  const [view, setView] = useState<"root" | "settings">("root");
  const [query, setQuery] = useState("");
  const [home, setHome] = useState<Home | null>(null);
  const [results, setResults] = useState<Item[] | null>(null);
  const [selected, setSelected] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  const showToast = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const showError = useCallback((e: unknown) => showToast(errorMessage(e), true), [showToast]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const loadHome = useCallback(() => {
    api.getHome().then(setHome).catch(showError);
  }, [showError]);

  // Latest-request-wins search: stale responses are dropped.
  const runSearch = useCallback(
    (q: string, selectFirst: boolean) => {
      const seq = ++searchSeq.current;
      if (!q.trim()) {
        setResults(null);
        return;
      }
      api
        .search(q)
        .then((items) => {
          if (seq !== searchSeq.current) return;
          setResults(items);
          if (selectFirst) setSelected(items[0] ? valueOf("res", items[0].id) : "");
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

  const focusInput = useCallback(() => requestAnimationFrame(() => inputRef.current?.focus()), []);

  // Backend events.
  useEffect(() => {
    loadHome();
    const offs = [
      on(events.shown, () => {
        loadHome();
        focusInput();
      }),
      on(events.hidden, () => {
        // Reset while hidden so the next open starts clean without flicker.
        setQuery("");
        setResults(null);
        setActionsOpen(false);
        setView("root");
        listRef.current?.scrollTo({ top: 0 });
      }),
      on(events.appsChanged, refresh),
      on(events.openSettings, () => setView("settings")),
    ];
    return () => offs.forEach((off) => off());
  }, [loadHome, refresh, focusInput]);

  const sections: Section[] = useMemo(() => {
    if (results) return [{ key: "res", title: "Results", items: results }];
    if (!home) return [];
    return [
      { key: "fav", title: "Favorites", items: home.favorites },
      { key: "sug", title: "Suggestions", items: home.suggestions },
      { key: "app", title: "Applications", items: home.applications },
    ].filter((s) => s.items.length > 0);
  }, [home, results]);

  const byValue = useMemo(() => {
    const map = new Map<string, Item>();
    for (const s of sections) for (const item of s.items) map.set(valueOf(s.key, item.id), item);
    return map;
  }, [sections]);

  // Keep the selection pointing at something that exists.
  useEffect(() => {
    if (!byValue.has(selected)) {
      const first = byValue.keys().next();
      setSelected(first.done ? "" : first.value);
    }
  }, [byValue, selected]);

  const current = byValue.get(selected) ?? null;

  const runAction = useCallback(
    async (action: ActionId, item: Item | null = current) => {
      setActionsOpen(false);
      focusInput();
      if (!item) return;
      try {
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
      } catch (e) {
        showError(e);
      }
    },
    [current, focusInput, refresh, showError, showToast],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (current) setActionsOpen((o) => !o);
      return;
    }
    if (ctrl && e.key === ",") {
      e.preventDefault();
      setView("settings");
      return;
    }
    // Ctrl+1…9 opens the matching favorite.
    if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key) && !results && home) {
      const fav = home.favorites[Number(e.key) - 1];
      if (fav) {
        e.preventDefault();
        void runAction("open", fav);
      }
      return;
    }
    const action = actionFromKey(e);
    if (action) {
      e.preventDefault();
      void runAction(action);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else void api.hide();
    }
  };

  if (view === "settings") {
    return (
      <div className="launcher">
        <SettingsView
          onBack={() => {
            setView("root");
            focusInput();
          }}
        />
      </div>
    );
  }

  return (
    <div className="launcher">
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
            placeholder="Search for apps and commands…"
            autoFocus
            spellCheck={false}
            maxLength={256}
          />
        </div>

        <Command.List ref={listRef} className="list">
          {home && (
            <Command.Empty className="empty">No results for “{query}”</Command.Empty>
          )}
          {sections.map((s) => (
            <Command.Group key={s.key} heading={s.title} className="group">
              {s.items.map((item) => (
                <Row
                  key={item.id}
                  value={valueOf(s.key, item.id)}
                  item={item}
                  onOpen={() => void runAction("open", item)}
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
            <button className="icon-btn" aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => setView("settings")}>
              <GearIcon />
            </button>
          )}
        </div>
        {current && (
          <div className="footer__right">
            <button className="footer__action" onClick={() => void runAction("open")}>
              Open Application <Kbd keys={["↵"]} />
            </button>
            <span className="footer__divider" />
            <button className="footer__action" onClick={() => setActionsOpen((o) => !o)}>
              Actions <Kbd keys={["Ctrl", "K"]} />
            </button>
          </div>
        )}
      </footer>

      {actionsOpen && current && (
        <ActionPanel
          title={current.name}
          actions={actionsFor(current)}
          onRun={(id) => void runAction(id)}
          onClose={() => {
            setActionsOpen(false);
            focusInput();
          }}
        />
      )}
    </div>
  );
}

const KIND_LABEL: Record<Item["kind"], string> = {
  desktop: "Application",
  store: "Store App",
  link: "Shortcut",
};

const Row = memo(function Row({ item, value, onOpen }: { item: Item; value: string; onOpen: () => void }) {
  return (
    <Command.Item value={value} className="row" onSelect={onOpen}>
      <AppIcon item={item} />
      <span className="row__name">
        <Highlight text={item.name} matches={item.matches} />
      </span>
      {item.pinned && <span className="row__pin" title="Favorite">★</span>}
      <span className="row__kind">{KIND_LABEL[item.kind]}</span>
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
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"
      />
    </svg>
  );
}
