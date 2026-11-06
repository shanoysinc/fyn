import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseColor, toHex } from "../lib/color";
import { asUrl } from "../lib/entries";
import { api, errorMessage, events, on, type ClipEntry, type ClipStatus } from "../lib/ipc";
import { ActionPanel, type PanelAction } from "./ActionPanel";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

interface Toast {
  text: string;
  error?: boolean;
}

/** "keepassxc.exe" -> "keepassxc" */
const appName = (exe: string | null) => (exe ? exe.replace(/\.exe$/i, "") : null);

export function relativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - unixSeconds));
  if (s < 45) return "Just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  const days = Math.round(s / 86_400);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

/** What an item is, for its icon. */
function kindOf(entry: ClipEntry): "link" | "color" | "text" {
  const t = entry.text.trim();
  if (/^(#|rgba?\(|hsla?\()/i.test(t) && parseColor(t)) return "color";
  if (!/\s/.test(t) && asUrl(t)) return "link";
  return "text";
}

function ClipIcon({ entry }: { entry: ClipEntry }) {
  const kind = kindOf(entry);
  if (kind === "color") {
    return <span className="glyph-tile glyph-tile--swatch" style={{ background: toHex(parseColor(entry.text.trim())!) }} />;
  }
  const [glyph, tint] = kind === "link" ? (["globe", "#0090ff"] as const) : (["text", "#64748b"] as const);
  return (
    <span className="glyph-tile" style={{ background: tint }}>
      <Glyph name={glyph} size={15} />
    </span>
  );
}

export function ClipboardView({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<ClipStatus | null>(null);
  const [items, setItems] = useState<ClipEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [panel, setPanel] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const showError = useCallback((e: unknown) => setToast({ text: errorMessage(e), error: true }), []);

  const load = useCallback(async () => {
    try {
      const s = await api.clipboardStatus();
      setStatus(s);
      // Nothing is listed (or even asked for) until clipboard history is turned on.
      if (s.enabled) setItems(await api.clipboardList());
    } catch (e) {
      showError(e);
    }
  }, [showError]);

  useEffect(() => {
    void load();
    return on(events.clipboardChanged, () => void load());
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.text.toLowerCase().includes(q) || appName(i.source)?.toLowerCase().includes(q));
  }, [items, query]);

  // Keep the selection on an item that exists.
  useEffect(() => {
    if (!visible.some((i) => String(i.id) === selected)) setSelected(visible[0] ? String(visible[0].id) : "");
  }, [visible, selected]);

  // "Press again to clear" lasts a few seconds (long enough to reopen the actions menu).
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const current = visible.find((i) => String(i.id) === selected) ?? null;

  const run = useCallback(
    async (action: string, entry: ClipEntry | null = current) => {
      setPanel(false);
      inputRef.current?.focus();
      try {
        switch (action) {
          case "paste":
            if (entry) await api.clipboardPaste(entry.id);
            break;
          case "copy":
            if (entry) {
              await api.clipboardCopy(entry.id);
              setToast({ text: "Copied to clipboard" });
            }
            break;
          case "delete":
            if (entry) {
              await api.clipboardDelete(entry.id);
              setToast({ text: "Deleted from history" });
            }
            break;
          case "pause":
            setStatus(await api.clipboardPause(15));
            setToast({ text: "Paused for 15 minutes" });
            break;
          case "pause-forever":
            setStatus(await api.clipboardPause(0));
            setToast({ text: "Paused until you resume" });
            break;
          case "resume":
            setStatus(await api.clipboardPause(null));
            setToast({ text: "Recording copies again" });
            break;
          case "clear":
            if (!confirmClear) {
              setConfirmClear(true);
              setToast({ text: "Press again to delete all clipboard history" });
              return;
            }
            setConfirmClear(false);
            await api.clipboardClear();
            setToast({ text: "Clipboard history cleared" });
            break;
        }
      } catch (e) {
        showError(e);
      }
    },
    [confirmClear, current, showError],
  );

  const actions: PanelAction[] = useMemo(() => {
    const list: PanelAction[] = [];
    if (current) {
      list.push(
        { id: "paste", title: "Paste", keys: ["↵"] },
        { id: "copy", title: "Copy to Clipboard", keys: ["Ctrl", "↵"] },
        { id: "delete", title: "Delete", keys: ["Ctrl", "⌫"] },
      );
    }
    if (status?.paused) list.push({ id: "resume", title: "Resume Recording" });
    else list.push({ id: "pause", title: "Pause for 15 Minutes" }, { id: "pause-forever", title: "Pause Until Resumed" });
    list.push({ id: "clear", title: confirmClear ? "Press Again to Clear All" : "Clear All History…" });
    return list;
  }, [confirmClear, current, status?.paused]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setPanel((p) => !p);
    } else if (ctrl && e.key === "Enter") {
      e.preventDefault();
      void run("copy");
    } else if (ctrl && e.key === "Backspace") {
      e.preventDefault();
      void run("delete");
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else onBack();
    }
  };

  if (!status) return <div className="subview" />;
  if (!status.enabled) {
    return <ClipboardIntro status={status} onBack={onBack} onEnabled={() => void load()} onError={showError} />;
  }

  const now = Date.now() / 1000;

  return (
    <div className="subview">
      <Command
        className="cmdk"
        label="Clipboard history"
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={setSelected}
        onKeyDown={onKeyDown}
      >
        <ViewHeader onBack={onBack}>
          <Command.Input
            ref={inputRef}
            className="search__input"
            value={query}
            onValueChange={setQuery}
            placeholder="Search clipboard history…"
            autoFocus
            spellCheck={false}
            maxLength={256}
          />
        </ViewHeader>

        <div className="clip">
          <Command.List className="list clip__list">
            {items.length === 0 ? (
              <div className="empty">
                {status.paused ? "Paused. New copies aren't recorded." : "Nothing yet. Copy some text and it shows up here."}
              </div>
            ) : (
              <Command.Empty className="empty">No matches for “{query}”</Command.Empty>
            )}
            {visible.map((entry) => (
              <Command.Item
                key={entry.id}
                value={String(entry.id)}
                className="row clip__row"
                onSelect={() => void run("paste", entry)}
              >
                <ClipIcon entry={entry} />
                <span className="row__name">{entry.text.trim().split("\n")[0]}</span>
                <span className="clip__time">{relativeTime(entry.created, now)}</span>
              </Command.Item>
            ))}
          </Command.List>

          <aside className="clip__preview">
            {current && (
              <>
                <pre className="clip__text">
                  {current.text}
                  {current.truncated ? "\n…" : ""}
                </pre>
                <dl className="clip__meta">
                  {current.source && (
                    <>
                      <dt>From</dt>
                      <dd>{appName(current.source)}</dd>
                    </>
                  )}
                  <dt>Copied</dt>
                  <dd>{relativeTime(current.created, now)}</dd>
                  <dt>Characters</dt>
                  <dd>{current.chars.toLocaleString("en-US")}</dd>
                </dl>
              </>
            )}
          </aside>
        </div>
      </Command>

      <footer className="footer">
        <div className="footer__left">
          {toast ? (
            <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>
          ) : (
            status.paused && (
              <button className="pill" onClick={() => void run("resume")} title="Resume recording copies">
                Paused · Resume
              </button>
            )
          )}
        </div>
        <div className="footer__right">
          {current && (
            <>
              <button className="footer__action" onClick={() => void run("paste")}>
                Paste <Kbd keys={["↵"]} />
              </button>
              <span className="footer__divider" />
            </>
          )}
          <button className="footer__action" onClick={() => setPanel((p) => !p)}>
            Actions <Kbd keys={["Ctrl", "K"]} />
          </button>
        </div>
      </footer>

      {panel && (
        <ActionPanel
          title={current ? "Clipboard item" : "Clipboard history"}
          actions={actions}
          onRun={(id) => void run(id)}
          onClose={() => {
            setPanel(false);
            inputRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** Shown until clipboard history is turned on: what it keeps, and how it protects you. */
function ClipboardIntro({
  status,
  onBack,
  onEnabled,
  onError,
}: {
  status: ClipStatus;
  onBack: () => void;
  onEnabled: () => void;
  onError: (e: unknown) => void;
}) {
  const turnOn = useCallback(() => {
    api
      .setClipboardSettings({ ...status, enabled: true })
      .then(onEnabled)
      .catch(onError);
  }, [onEnabled, onError, status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A focused button (e.g. "Not Now") handles its own Enter.
      const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
      if (e.key === "Enter" && !onButton) {
        e.preventDefault();
        turnOn();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, turnOn]);

  return (
    <div className="subview clip-intro">
      <ViewHeader onBack={onBack}>
        <h1 className="clip-intro__title">Clipboard History</h1>
      </ViewHeader>
      <div className="clip-intro__body">
        <span className="glyph-tile clip-intro__icon" style={{ background: "#7c3aed" }}>
          <Glyph name="clipboard" size={26} />
        </span>
        <p className="clip-intro__lead">
          Search and paste anything you copied in the last {status.retentionDays} day{status.retentionDays === 1 ? "" : "s"}.
          It stays on this PC, encrypted with your Windows account.
        </p>
        <ul className="clip-intro__points">
          <li>Copies from password managers are never recorded.</li>
          <li>Passwords, API keys, tokens and card numbers are never kept, not even for a moment.</li>
          <li>Pause any time; turning it off deletes everything.</li>
        </ul>
        <div className="clip-intro__actions">
          <button className="btn" onClick={onBack}>
            Not Now
          </button>
          <button className="btn btn--primary" onClick={turnOn} autoFocus>
            Turn On <Kbd keys={["↵"]} />
          </button>
        </div>
      </div>
    </div>
  );
}
