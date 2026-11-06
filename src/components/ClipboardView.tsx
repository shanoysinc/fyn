import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseColor, toHex } from "../lib/color";
import { asUrl } from "../lib/entries";
import { formatBytes, relativeTime } from "../lib/format";
import { api, errorMessage, events, iconUrl, on, type ClipEntry, type ClipStatus } from "../lib/ipc";
import type { GlyphName } from "../lib/entries";
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

/** What an item is, for its icon. */
type Filter = "all" | "text" | "image";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "text", label: "Text" },
  { id: "image", label: "Images" },
];

/** Why the list is empty, for the current filter and search. */
function emptyMessage(status: ClipStatus, filter: Filter, hasItems: boolean, query: string): string {
  if (query.trim()) return `No matches for “${query.trim()}”`;
  if (filter === "image" && !status.includeImages) return "Images are off. Turn them on to keep screenshots and copied pictures.";
  if (filter === "image") return "No images yet. Copy a picture or take a screenshot.";
  if (filter === "text" && hasItems) return "No text yet.";
  if (status.paused) return "Paused. New copies aren't recorded.";
  return status.includeImages
    ? "Nothing yet. Copy some text or an image and it shows up here."
    : "Nothing yet. Copy some text and it shows up here.";
}

/** Words that find images in search (they have no text of their own). */
const IMAGE_WORDS = ["image", "screenshot", "picture", "photo", "png"];

/** One-line label for the list. */
function label(entry: ClipEntry): string {
  if (entry.kind === "image") return `Image · ${entry.width} × ${entry.height}`;
  return entry.text.trim().split("\n")[0];
}

function kindOf(entry: ClipEntry): "image" | "link" | "color" | "text" {
  if (entry.kind === "image") return "image";
  const t = entry.text.trim();
  if (/^(#|rgba?\(|hsla?\()/i.test(t) && parseColor(t)) return "color";
  if (!/\s/.test(t) && asUrl(t)) return "link";
  return "text";
}

function ClipIcon({ entry }: { entry: ClipEntry }) {
  const kind = kindOf(entry);
  if (kind === "image") {
    return <img className="clip__thumb" src={entry.thumb ?? undefined} alt="" draggable={false} />;
  }
  if (kind === "color") {
    return <span className="glyph-tile glyph-tile--swatch" style={{ background: toHex(parseColor(entry.text.trim())!) }} />;
  }
  if (kind === "link") return <SoftTile glyph="globe" tint="#0090ff" />;
  // Text: the app it came from says the most (VS Code, Chrome, Word…); otherwise a document.
  return <SourceIcon path={entry.sourceIcon} fallback={<SoftTile glyph="doc" tint="#8b8b94" />} />;
}

/** A light wash of colour with the symbol in that colour: calmer than a solid block. */
export function SoftTile({ glyph, tint }: { glyph: GlyphName; tint: string }) {
  return (
    <span className="glyph-tile glyph-tile--soft" style={{ "--tint": tint } as React.CSSProperties}>
      <Glyph name={glyph} size={15} />
    </span>
  );
}

export function SourceIcon({ path, fallback }: { path: string | null; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!path || failed) return <>{fallback}</>;
  return <img className="app-icon app-icon--loaded" src={iconUrl(path)} alt="" draggable={false} onError={() => setFailed(true)} />;
}

export function ClipboardView({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<ClipStatus | null>(null);
  const [items, setItems] = useState<ClipEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [panel, setPanel] = useState(false);
  /** Where a right-click opened the actions menu; null = above the footer (Ctrl+K). */
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
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
    return items.filter(
      (i) =>
        (filter === "all" || i.kind === filter) &&
        (!q ||
          i.text.toLowerCase().includes(q) ||
          appName(i.source)?.toLowerCase().includes(q) ||
          (i.kind === "image" && IMAGE_WORDS.some((w) => w.startsWith(q)))),
    );
  }, [items, query, filter]);

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

  // Full-size images are decrypted only when one is selected, and cached for the visit.
  const [fullImages, setFullImages] = useState<Record<number, string>>({});
  useEffect(() => {
    if (current?.kind !== "image" || fullImages[current.id]) return;
    const id = current.id;
    api
      .clipboardImage(id)
      .then((url) => setFullImages((m) => ({ ...m, [id]: url })))
      .catch(showError);
  }, [current, fullImages, showError]);

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
          case "images-on":
            if (status) {
              setStatus(await api.setClipboardSettings({ ...status, includeImages: true }));
              setToast({ text: "Images you copy are kept from now on" });
            }
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
    [confirmClear, current, showError, status],
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
    if (status && !status.includeImages) list.push({ id: "images-on", title: "Turn On Images" });
    list.push({ id: "clear", title: confirmClear ? "Press Again to Clear All" : "Clear All History…" });
    return list;
  }, [confirmClear, current, status]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setAnchor(null);
      setPanel((p) => !p);
    } else if (ctrl && !e.shiftKey && /^[1-3]$/.test(e.key)) {
      e.preventDefault();
      setFilter(FILTERS[Number(e.key) - 1].id);
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
          <div className="segmented segmented--compact" role="radiogroup" aria-label="Show">
            {FILTERS.map((f, i) => (
              <button
                key={f.id}
                role="radio"
                aria-checked={filter === f.id}
                className={`segmented__item ${filter === f.id ? "segmented__item--on" : ""}`}
                onMouseDown={(e) => e.preventDefault()} // keep focus in the search box
                onClick={() => setFilter(f.id)}
                title={`${f.label} (Ctrl+${i + 1})`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </ViewHeader>

        <div className="clip">
          <Command.List className="list clip__list">
            {visible.length === 0 && (
              <div className="empty">{emptyMessage(status, filter, items.length > 0, query)}</div>
            )}
            {visible.map((entry) => (
              <Command.Item
                key={entry.id}
                value={String(entry.id)}
                className="row clip__row"
                onSelect={() => void run("paste", entry)}
                onContextMenu={(e) => {
                  // Right-click: select the item and open its actions at the pointer.
                  e.preventDefault();
                  setSelected(String(entry.id));
                  setAnchor({ x: e.clientX, y: e.clientY });
                  setPanel(true);
                }}
              >
                <ClipIcon entry={entry} />
                <span className="row__name">{label(entry)}</span>
                <span className="clip__time">{relativeTime(entry.created, now)}</span>
              </Command.Item>
            ))}
          </Command.List>

          <aside className="clip__preview">
            {current && (
              <>
                {current.kind === "image" ? (
                  <div className="clip__image">
                    {/* The thumbnail shows instantly; the full image replaces it once decrypted. */}
                    <img src={fullImages[current.id] ?? current.thumb ?? undefined} alt="" draggable={false} />
                  </div>
                ) : (
                  <pre className="clip__text">
                    {current.text}
                    {current.truncated ? "\n…" : ""}
                  </pre>
                )}
                <dl className="clip__meta">
                  {current.source && (
                    <>
                      <dt>From</dt>
                      <dd>{appName(current.source)}</dd>
                    </>
                  )}
                  <dt>Copied</dt>
                  <dd>{relativeTime(current.created, now)}</dd>
                  {current.kind === "image" ? (
                    <>
                      <dt>Dimensions</dt>
                      <dd>
                        {current.width} × {current.height}
                      </dd>
                      <dt>Size</dt>
                      <dd>{formatBytes(current.bytes ?? 0)}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Characters</dt>
                      <dd>{current.chars.toLocaleString("en-US")}</dd>
                    </>
                  )}
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
            <>
              {status.paused && (
                <button className="pill" onClick={() => void run("resume")} title="Resume recording copies">
                  Paused · Resume
                </button>
              )}
              {!status.paused && !status.includeImages && (
                <button
                  className="footer__hint-btn"
                  onClick={() => void run("images-on")}
                  title="Also keep screenshots and copied pictures (Settings → Clipboard history)"
                >
                  Images are off · Turn on
                </button>
              )}
            </>
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
          <button
            className="footer__action"
            onClick={() => {
              setAnchor(null);
              setPanel((p) => !p);
            }}
          >
            Actions <Kbd keys={["Ctrl", "K"]} />
          </button>
        </div>
      </footer>

      {panel && (
        <ActionPanel
          title={current ? (current.kind === "image" ? "Image" : "Clipboard item") : "Clipboard history"}
          actions={actions}
          anchor={anchor}
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
          <li>Images are off unless you turn them on in Settings.</li>
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
