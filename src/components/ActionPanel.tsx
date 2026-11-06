import { Command } from "cmdk";
import { useState } from "react";
import type { Action, ActionId } from "../lib/actions";
import { Kbd } from "./Kbd";

interface Props {
  title: string;
  actions: Action[];
  onRun: (id: ActionId) => void;
  onClose: () => void;
}

export function ActionPanel({ title, actions, onRun, onClose }: Props) {
  const [search, setSearch] = useState("");

  return (
    <>
      <div className="actions-backdrop" onMouseDown={onClose} />
      <Command
        className="actions"
        label="Actions"
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
            <Command.Item key={a.id} value={a.title} className="actions__item" onSelect={() => onRun(a.id)}>
              <span>{a.title}</span>
              <Kbd keys={a.keys} />
            </Command.Item>
          ))}
        </Command.List>
        <Command.Input
          className="actions__input"
          placeholder="Search for actions…"
          value={search}
          onValueChange={setSearch}
          autoFocus
        />
      </Command>
    </>
  );
}
