import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatsOf, isDark, parseColor, toHex, type Rgb } from "../lib/color";
import { api, copyText, errorMessage } from "../lib/ipc";
import { loadRecents, pushRecent } from "../lib/recents";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

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

  // Native eyedropper (Rust): Fyn hides, the next click anywhere picks that pixel, Fyn
  // comes back. Esc or right-click cancels. (The browser EyeDropper API isn't available
  // in WebView2, so this doesn't rely on it.)
  const pick = useCallback(async () => {
    try {
      const picked = await api.pickScreenColor();
      const parsed = picked ? parseColor(picked) : null;
      if (parsed) {
        const value = toHex(parsed);
        setInput(value);
        setColor(parsed);
        remember(value);
        setSelected("hex"); // ready to copy with ↵
        setToast({ text: `Picked ${value}. Press ↵ to copy` });
      }
    } catch (e) {
      setToast({ text: errorMessage(e), error: true });
    } finally {
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
          {/* A plain input, not cmdk's Command.Input: the box takes a colour code and never
              filters the list, and cmdk would re-select "Pick from Screen" whenever its
              text changed (so ↵ after a pick would start the picker again). */}
          <input
            ref={inputRef}
            className="search__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
