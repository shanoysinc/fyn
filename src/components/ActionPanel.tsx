import { Command } from "cmdk";
import { useState } from "react";
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
}

export function ActionPanel({ title, actions, onRun, onClose, placeholder = "Search for actions…" }: Props) {
  const [search, setSearch] = useState("");

  return (
    <>
      <div className="actions-backdrop" onMouseDown={onClose} />
      <Command
        className="actions"
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
