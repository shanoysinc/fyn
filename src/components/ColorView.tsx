import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatsOf, isDark, parseColor, toHex, type Rgb } from "../lib/color";
import { api, copyText, errorMessage } from "../lib/ipc";
import { loadRecents, pushRecent } from "../lib/recents";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open: () => Promise<EyeDropperResult> };

const DEFAULT = "#7C3AED";

export function ColorView({ initial, onBack }: { initial?: string; onBack: () => void }) {
  const [input, setInput] = useState(initial ?? "");
  const [color, setColor] = useState<Rgb>(() => parseColor(initial ?? "") ?? parseColor(DEFAULT)!);
  const [recents, setRecents] = useState(() => loadRecents("color"));
  const [selected, setSelected] = useState("pick");
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow the input as soon as it parses; keep the last valid colour otherwise.
  useEffect(() => {
    const parsed = parseColor(input);
    if (parsed) setColor(parsed);
  }, [input]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const formats = useMemo(() => formatsOf(color), [color]);
  const hex = toHex(color);
  const invalid = input.trim() !== "" && !parseColor(input);

  const remember = useCallback((value: string) => setRecents(pushRecent("color", value, 12)), []);

  const copy = useCallback(
    async (value: string) => {
      try {
        await copyText(value);
        remember(hex);
        setToast({ text: `Copied ${value}` });
      } catch (e) {
        setToast({ text: errorMessage(e), error: true });
      }
    },
    [hex, remember],
  );

  const pick = useCallback(async () => {
    const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (!EyeDropper) {
      setToast({ text: "Picking from the screen isn't supported here", error: true });
      return;
    }
    // Clicking elsewhere on screen would normally hide the launcher.
    await api.suspendAutoHide(true).catch(() => {});
    try {
      const { sRGBHex } = await new EyeDropper().open();
      const picked = parseColor(sRGBHex);
      if (picked) {
        const value = toHex(picked);
        setInput(value);
        setColor(picked);
        remember(value);
        setSelected("hex");
      }
    } catch {
      // Cancelled with Esc.
    } finally {
      await api.suspendAutoHide(false).catch(() => {});
      inputRef.current?.focus();
    }
  }, [remember]);

  const run = (value: string) => {
    if (value === "pick") void pick();
    else {
      const f = formats.find((x) => x.id === value);
      if (f) void copy(f.value);
    }
  };

  return (
    <div className="subview">
      <Command
        className="cmdk"
        label="Color picker"
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={setSelected}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
            e.preventDefault();
            void pick();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (input) setInput("");
            else onBack();
          }
        }}
      >
        <ViewHeader onBack={onBack}>
          <Command.Input
            ref={inputRef}
            className="search__input"
            value={input}
            onValueChange={setInput}
            placeholder="Type a color (#7c3aed, rgb(…), hsl(…)) or pick one from the screen"
            autoFocus
            spellCheck={false}
            maxLength={64}
          />
        </ViewHeader>

        <div className="color-view">
          <div className="color-view__swatch" style={{ background: hex, color: isDark(color) ? "#fff" : "#111" }}>
            <span>{hex}</span>
            {invalid && <small>Not a color yet</small>}
          </div>

          <Command.List className="list color-view__list">
            <Command.Item value="pick" className="row" onSelect={() => run("pick")}>
              <span className="glyph-tile" style={{ background: "#7c3aed" }}>
                <Glyph name="droplet" size={15} />
              </span>
              <span className="row__name">Pick from Screen</span>
              <Kbd keys={["Ctrl", "P"]} />
            </Command.Item>
            {formats.map((f) => (
              <Command.Item key={f.id} value={f.id} className="row" onSelect={() => run(f.id)}>
                <span className="format-label">{f.label}</span>
                <span className="row__name mono">{f.value}</span>
                <span className="row__kind">Copy</span>
              </Command.Item>
            ))}
          </Command.List>
        </div>

        {recents.length > 0 && (
          <div className="color-recents">
            <span>Recent</span>
            {recents.map((c) => (
              <button
                key={c}
                className="color-chip"
                style={{ background: c }}
                title={c}
                onClick={() => setInput(c)}
              />
            ))}
          </div>
        )}
      </Command>

      <footer className="footer">
        <div className="footer__left">
          {toast && <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>}
        </div>
        <div className="footer__right">
          <button className="footer__action" onClick={() => run(selected)}>
            {selected === "pick" ? "Pick Color" : "Copy"} <Kbd keys={["↵"]} />
          </button>
        </div>
      </footer>
    </div>
  );
}
