import { Command } from "cmdk";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Kbd } from "./Kbd";

export interface PanelAction {
  id: string;
  title: string;
  keys?: string[];
}

interface Props {
  title: string;
  actions: PanelAction[];
  onRun: (id: string) => void;
  onClose: () => void;
  placeholder?: string;
  /** Open at this point (a right-click) instead of above the footer. */
  anchor?: { x: number; y: number } | null;
}

const EDGE = 8;

export function ActionPanel({ title, actions, onRun, onClose, placeholder = "Search for actions…", anchor }: Props) {
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | undefined>(undefined);

  // Place the menu at the pointer, flipping left/up when it would leave the window.
  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPos(undefined);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const right = anchor.x + width > window.innerWidth - EDGE;
    const below = anchor.y + height <= window.innerHeight - EDGE;
    setPos({
      left: Math.max(EDGE, right ? anchor.x - width : anchor.x),
      top: Math.max(EDGE, below ? anchor.y : anchor.y - height),
      right: "auto",
      bottom: "auto",
      transformOrigin: `${right ? "right" : "left"} ${below ? "top" : "bottom"}`,
    });
  }, [anchor]);

  return (
    <>
      <div
        className="actions-backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <Command
        ref={ref}
        className={`actions ${anchor ? "actions--anchored" : ""}`}
        style={anchor ? { ...pos, visibility: pos ? "visible" : "hidden" } : undefined}
        label={title}
        loop
        onKeyDown={(e) => {
          if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="actions__title">{title}</div>
        <Command.List className="actions__list">
          <Command.Empty className="actions__empty">No matching actions</Command.Empty>
          {actions.map((a) => (
            <Command.Item key={a.id} value={`${a.title} ${a.id}`} className="actions__item" onSelect={() => onRun(a.id)}>
              <span>{a.title}</span>
              {a.keys && <Kbd keys={a.keys} />}
            </Command.Item>
          ))}
        </Command.List>
        <Command.Input
          className="actions__input"
          placeholder={placeholder}
          value={search}
          onValueChange={setSearch}
          autoFocus
        />
      </Command>
    </>
  );
}
