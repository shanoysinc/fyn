import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { PIN_COMMAND, type View } from "../lib/entries";
import { errorMessage } from "../lib/ipc";
import { MINI_APPS, type MiniApp } from "../miniapps/registry";
import { ActionPanel } from "./ActionPanel";
import { MiniAppIcon } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

/** Pin id of a mini app: the same as its search command, so it's one favorite either way. */
export const miniAppPinId = (app: MiniApp) => `${PIN_COMMAND}fyn:${app.id}`;

interface Props {
  onBack: () => void;
  onOpen: (view: View) => void;
  /** Pin ids currently in Favorites. */
  pinned: ReadonlySet<string>;
  /** Add or remove a favorite; resolves to the message to show. */
  onTogglePin: (pinId: string, title: string) => Promise<string>;
}

/** The Mini Apps screen: every built-in tool, what it does, and whether it's a favorite. */
export function MiniAppsView({ onBack, onOpen, pinned, onTogglePin }: Props) {
  const [selected, setSelected] = useState(MINI_APPS[0]?.id ?? "");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const current = MINI_APPS.find((a) => a.id === selected);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const togglePin = async (app: MiniApp | undefined) => {
    if (!app) return;
    try {
      setToast({ text: await onTogglePin(miniAppPinId(app), app.title) });
    } catch (e) {
      setToast({ text: errorMessage(e), error: true });
    }
  };

  const isPinned = (app: MiniApp) => pinned.has(miniAppPinId(app));

  return (
    <div className="subview">
      <Command
        className="cmdk"
        label="Mini apps"
        loop
        value={selected}
        onValueChange={setSelected}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (menu) setMenu(null);
            else onBack();
          } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
            e.preventDefault();
            void togglePin(current);
          }
        }}
      >
        <ViewHeader onBack={onBack}>
          <h1 className="clip-intro__title">Mini Apps</h1>
          {/* cmdk needs an input to drive the keyboard; keep it out of sight. */}
          <Command.Input className="visually-hidden" autoFocus aria-label="Mini apps" />
        </ViewHeader>

        <Command.List className="list miniapps">
          {MINI_APPS.map((app) => (
            <Command.Item
              key={app.id}
              value={app.id}
              className="miniapp"
              onSelect={() => onOpen(app.view)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(app.id);
                setMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              <MiniAppIcon glyph={app.glyph} gradient={app.gradient} size={24} />
              <span className="miniapp__text">
                <span className="miniapp__title">{app.title}</span>
                <span className="miniapp__desc">{app.description}</span>
              </span>
              <button
                className={`miniapp__star ${isPinned(app) ? "miniapp__star--on" : ""}`}
                aria-label={isPinned(app) ? `Remove ${app.title} from Favorites` : `Add ${app.title} to Favorites`}
                aria-pressed={isPinned(app)}
                title={isPinned(app) ? "Remove from Favorites (Ctrl+Shift+P)" : "Add to Favorites (Ctrl+Shift+P)"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation(); // don't also open the app
                  void togglePin(app);
                }}
              >
                <StarIcon filled={isPinned(app)} />
              </button>
            </Command.Item>
          ))}
          <div className="miniapps__more">More mini apps are on the way.</div>
        </Command.List>
      </Command>

      <footer className="footer">
        <div className="footer__left">
          {toast && <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>}
        </div>
        {current && (
          <div className="footer__right">
            <button className="footer__action" onClick={() => void togglePin(current)}>
              {isPinned(current) ? "Remove from Favorites" : "Add to Favorites"} <Kbd keys={["Ctrl", "Shift", "P"]} />
            </button>
            <span className="footer__divider" />
            <button className="footer__action" onClick={() => onOpen(current.view)}>
              Open <Kbd keys={["↵"]} />
            </button>
          </div>
        )}
      </footer>

      {menu && current && (
        <ActionPanel
          title={current.title}
          anchor={menu}
          actions={[
            { id: "open", title: "Open", keys: ["↵"] },
            {
              id: "pin",
              title: isPinned(current) ? "Remove from Favorites" : "Add to Favorites",
              keys: ["Ctrl", "Shift", "P"],
            },
          ]}
          onRun={(id) => {
            setMenu(null);
            if (id === "open") onOpen(current.view);
            else void togglePin(current);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        d="M11.1 2.9a1 1 0 0 1 1.8 0l2.4 4.9 5.4.8a1 1 0 0 1 .6 1.7l-3.9 3.8.9 5.4a1 1 0 0 1-1.5 1l-4.8-2.5-4.8 2.5a1 1 0 0 1-1.5-1l.9-5.4-3.9-3.8a1 1 0 0 1 .6-1.7l5.4-.8Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
