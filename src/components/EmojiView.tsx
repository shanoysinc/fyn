import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emojiByChar, EMOJI, GROUPS, searchEmoji, type Emoji } from "../lib/emoji";
import { copyText, errorMessage } from "../lib/ipc";
import { loadRecents, pushRecent } from "../lib/recents";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

const COLUMNS = 10;

interface Section {
  title: string;
  items: Emoji[];
}

export default function EmojiView({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState(() => loadRecents("emoji"));
  const [index, setIndex] = useState(0);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const sections: Section[] = useMemo(() => {
    if (query.trim()) {
      const items = searchEmoji(query);
      return items.length ? [{ title: "Results", items }] : [];
    }
    const recent = recents.map(emojiByChar).filter((e): e is Emoji => !!e);
    return [
      ...(recent.length ? [{ title: "Recently Used", items: recent }] : []),
      ...GROUPS.map((g) => ({ title: g, items: EMOJI.filter((e) => e.group === g) })),
    ];
  }, [query, recents]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const current = flat[Math.min(index, flat.length - 1)];

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the selected cell visible.
  useEffect(() => {
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const copy = useCallback(async (e: Emoji | undefined) => {
    if (!e) return;
    try {
      await copyText(e.char);
      setRecents(pushRecent("emoji", e.char, COLUMNS * 2));
      setToast({ text: `Copied ${e.char} to clipboard` });
    } catch (err) {
      setToast({ text: errorMessage(err), error: true });
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (delta: number) => {
      e.preventDefault();
      setIndex((i) => Math.max(0, Math.min(flat.length - 1, i + delta)));
    };
    switch (e.key) {
      case "ArrowRight":
        return move(1);
      case "ArrowLeft":
        return move(-1);
      case "ArrowDown":
        return move(COLUMNS);
      case "ArrowUp":
        return move(-COLUMNS);
      case "Enter":
        e.preventDefault();
        void copy(current);
        return;
      case "Escape":
        e.preventDefault();
        if (query) setQuery("");
        else onBack();
    }
  };

  let offset = 0;
  return (
    <div className="subview" onKeyDown={onKeyDown}>
      <ViewHeader onBack={onBack}>
        <input
          className="search__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          autoFocus
          spellCheck={false}
          maxLength={64}
        />
      </ViewHeader>

      <div className="emoji-grid" ref={gridRef}>
        {sections.length === 0 && <div className="empty">No emoji for “{query}”</div>}
        {sections.map((s) => {
          const start = offset;
          offset += s.items.length;
          return (
            <section key={s.title}>
              <div className="emoji-grid__heading">{s.title}</div>
              <div className="emoji-grid__cells">
                {s.items.map((e, i) => (
                  <button
                    key={e.char}
                    data-index={start + i}
                    className={`emoji-cell ${start + i === index ? "emoji-cell--selected" : ""}`}
                    title={e.name}
                    tabIndex={-1}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      setIndex(start + i);
                      void copy(e);
                    }}
                  >
                    {e.char}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <footer className="footer">
        <div className="footer__left">
          {toast ? (
            <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>
          ) : (
            current && <span className="footer__hint">{current.name}</span>
          )}
        </div>
        {current && (
          <div className="footer__right">
            <button className="footer__action" onClick={() => void copy(current)}>
              Copy Emoji <Kbd keys={["↵"]} />
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}
