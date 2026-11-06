import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../lib/format";
import { api, errorMessage, type CleanSettings, type ScanCategory, type ScanReport } from "../lib/ipc";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

interface Toast {
  text: string;
  error?: boolean;
}

/** Categories whose items (emulators, images) are picked one by one. */
const hasItems = (c: ScanCategory) => c.id === "avd" || c.id === "sdk-images";

/** What a clean would delete right now, and how much it frees. */
export function selection(report: ScanReport | null, checked: Set<string>) {
  const categories: string[] = [];
  const items: string[] = [];
  let bytes = 0;
  for (const c of report?.categories ?? []) {
    if (!c.enabled || !c.available) continue;
    if (hasItems(c)) {
      for (const i of c.items) {
        if (checked.has(i.id) && !i.protected) {
          items.push(i.id);
          bytes += i.bytes;
        }
      }
    } else if (c.bytes > 0) {
      categories.push(c.id);
      bytes += c.bytes;
    }
  }
  return { categories, items, bytes };
}

export function CleanView({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<CleanSettings | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [newWord, setNewWord] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const showError = useCallback((e: unknown) => setToast({ text: errorMessage(e), error: true }), []);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setReport(await api.cleanScan());
    } catch (e) {
      showError(e);
    } finally {
      setScanning(false);
    }
  }, [showError]);

  useEffect(() => {
    api.cleanSettings().then(setSettings).catch(showError);
    void scan();
  }, [scan, showError]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 5000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // "Press Enter again to delete" lasts a few seconds.
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  // Found things first; categories with nothing on this PC go to the bottom.
  const categories = useMemo(() => {
    const list = report?.categories ?? [];
    return [...list.filter((c) => c.available), ...list.filter((c) => !c.available)];
  }, [report]);

  const plan = useMemo(() => selection(report, checked), [report, checked]);

  const saveSettings = useCallback(
    async (next: CleanSettings) => {
      try {
        const saved = await api.setCleanSettings(next);
        setSettings(saved);
        return saved;
      } catch (e) {
        showError(e);
        return null;
      }
    },
    [showError],
  );

  /** Switch a category on or off (remembered), or tick an emulator / image (this visit only). */
  const toggle = useCallback(
    async (value: string) => {
      setConfirm(false);
      if (value.startsWith("avd:") || value.startsWith("image:")) {
        const item = report?.categories.flatMap((c) => c.items).find((i) => i.id === value);
        if (!item || item.protected) return;
        setChecked((s) => {
          const next = new Set(s);
          if (next.has(value)) next.delete(value);
          else next.add(value);
          return next;
        });
        return;
      }
      if (!settings) return;
      const on = settings.enabled.includes(value);
      const enabled = on ? settings.enabled.filter((id) => id !== value) : [...settings.enabled, value];
      const saved = await saveSettings({ ...settings, enabled });
      if (saved) {
        setReport((r) =>
          r && { ...r, categories: r.categories.map((c) => (c.id === value ? { ...c, enabled: !on } : c)) },
        );
      }
    },
    [report, saveSettings, settings],
  );

  const clean = useCallback(async () => {
    if (cleaning || scanning || plan.bytes === 0) return;
    if (!confirm) {
      setConfirm(true);
      setToast({ text: `Press ↵ again to delete ${formatBytes(plan.bytes)}` });
      return;
    }
    setConfirm(false);
    setCleaning(true);
    try {
      const result = await api.cleanRun(plan.categories, plan.items);
      const skipped = result.skippedFiles ? `. ${result.skippedFiles} files in use were skipped` : "";
      setToast({ text: `Freed ${formatBytes(result.freedBytes)}${skipped}`, error: result.errors.length > 0 });
      setChecked(new Set());
      await scan();
    } catch (e) {
      showError(e);
    } finally {
      setCleaning(false);
    }
  }, [cleaning, confirm, plan, scan, scanning, showError]);

  const addWord = async () => {
    const word = newWord.trim();
    if (!word || !settings) return;
    setNewWord("");
    if (await saveSettings({ ...settings, protected: [...settings.protected, word] })) await scan();
  };

  const removeWord = async (word: string) => {
    if (!settings) return;
    if (await saveSettings({ ...settings, protected: settings.protected.filter((w) => w !== word) })) await scan();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && e.target !== inputRef.current) return; // typing a protected name
    if (e.key === "Enter") {
      e.preventDefault();
      void clean();
    } else if (e.key === " ") {
      e.preventDefault();
      if (selected) void toggle(selected);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      void scan();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onBack();
    }
  };

  const disk = report?.disk;

  return (
    <div className="subview">
      <Command className="cmdk" label="Clean Windows" loop value={selected} onValueChange={setSelected} onKeyDown={onKeyDown}>
        <ViewHeader onBack={onBack}>
          <h1 className="clip-intro__title">Clean Windows</h1>
          <Command.Input ref={inputRef} className="visually-hidden" autoFocus aria-label="Clean Windows" />
          {disk && (
            <span className="clean__disk" title="Free space on your Windows drive">
              <span className="clean__disk-bar">
                <span style={{ width: `${Math.round((1 - disk.free / disk.total) * 100)}%` }} />
              </span>
              {formatBytes(disk.free)} free
            </span>
          )}
        </ViewHeader>

        <Command.List className="list clean">
          {!report && <div className="empty">{scanning ? "Scanning…" : "Couldn't scan"}</div>}
          {categories.map((c) => (
            <CategoryRows key={c.id} category={c} checked={checked} onToggle={(v) => void toggle(v)} />
          ))}

          {settings && (
            <section className="clean__protected">
              <div className="setting__title">
                <Glyph name="lock" size={13} /> Never touch anything named
              </div>
              <div className="chips">
                {settings.protected.map((w) => (
                  <span key={w} className="chip">
                    {w}
                    <button aria-label={`Unprotect ${w}`} onClick={() => void removeWord(w)}>
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="chip-input"
                  value={newWord}
                  onChange={(e) => setNewWord(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addWord();
                    }
                  }}
                  placeholder="Add a name, e.g. clinic"
                  spellCheck={false}
                  maxLength={40}
                />
              </div>
            </section>
          )}
        </Command.List>
      </Command>

      <footer className="footer">
        <div className="footer__left">
          {toast ? (
            <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>
          ) : (
            <span className="footer__hint">
              {scanning ? "Scanning…" : cleaning ? "Cleaning…" : <>Space to switch · <Kbd keys={["Ctrl", "R"]} /> rescan</>}
            </span>
          )}
        </div>
        <div className="footer__right">
          <button
            className="btn btn--primary clean__go"
            disabled={plan.bytes === 0 || scanning || cleaning}
            onClick={() => void clean()}
          >
            {confirm ? "Press ↵ to Confirm" : plan.bytes ? `Free ${formatBytes(plan.bytes)}` : "Nothing selected"}
            <Kbd keys={["↵"]} />
          </button>
        </div>
      </footer>
    </div>
  );
}

function Checkbox({ on, disabled }: { on: boolean; disabled?: boolean }) {
  return (
    <span className={`check ${on ? "check--on" : ""} ${disabled ? "check--disabled" : ""}`} aria-hidden>
      {on && (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function CategoryRows({
  category: c,
  checked,
  onToggle,
}: {
  category: ScanCategory;
  checked: Set<string>;
  onToggle: (value: string) => void;
}) {
  const size = !c.available
    ? "Not found"
    : hasItems(c)
      ? `${c.items.length} found`
      : c.bytes === 0
        ? "Already clean"
        : formatBytes(c.bytes);

  return (
    <>
      <Command.Item
        value={c.id}
        className={`row clean__row ${c.available ? "" : "clean__row--missing"}`}
        onSelect={() => onToggle(c.id)}
        role="checkbox"
        aria-checked={c.enabled}
      >
        <Checkbox on={c.enabled} />
        <span className="clean__text">
          <span className="clean__title">
            {c.title}
            {c.optional && <span className="clean__tag">Optional</span>}
          </span>
          <span className="clean__desc">{c.description}</span>
        </span>
        <span className="clean__size">{size}</span>
      </Command.Item>

      {c.enabled &&
        hasItems(c) &&
        c.items.map((i) => (
          <Command.Item
            key={i.id}
            value={i.id}
            className={`row clean__row clean__row--item ${i.protected ? "clean__row--protected" : ""}`}
            onSelect={() => onToggle(i.id)}
            role="checkbox"
            aria-checked={checked.has(i.id)}
            aria-disabled={i.protected}
          >
            {i.protected ? <Glyph name="lock" size={13} /> : <Checkbox on={checked.has(i.id)} />}
            <span className="clean__text">
              <span className="clean__title">{i.name}</span>
              <span className="clean__desc">{i.protected ? (i.note ?? "Protected") : i.note}</span>
            </span>
            <span className="clean__size">{i.protected ? "Protected" : formatBytes(i.bytes)}</span>
          </Command.Item>
        ))}
    </>
  );
}
