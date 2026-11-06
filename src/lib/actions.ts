import type { KeyboardEvent } from "react";
import type { Item } from "./ipc";

export type ActionId = "open" | "admin" | "reveal" | "pin" | "copy" | "pin-up" | "pin-down";

export interface Action {
  id: ActionId;
  title: string;
  keys: string[];
}

export function actionsFor(item: Item): Action[] {
  const list: Action[] = [{ id: "open", title: "Open Application", keys: ["↵"] }];
  if (item.canRunAsAdmin) {
    list.push({ id: "admin", title: "Run as Administrator", keys: ["Ctrl", "Shift", "↵"] });
  }
  list.push(
    { id: "reveal", title: "Show in File Explorer", keys: ["Ctrl", "↵"] },
    {
      id: "pin",
      title: item.pinned ? "Remove from Favorites" : "Add to Favorites",
      keys: ["Ctrl", "Shift", "P"],
    },
  );
  if (item.pinned) {
    list.push(
      { id: "pin-up", title: "Move Up in Favorites", keys: ["Ctrl", "Shift", "↑"] },
      { id: "pin-down", title: "Move Down in Favorites", keys: ["Ctrl", "Shift", "↓"] },
    );
  }
  list.push({ id: "copy", title: "Copy Path", keys: ["Ctrl", "Shift", "C"] });
  return list;
}

/** Keyboard shortcut -> action, for use while the main list is focused. */
export function actionFromKey(e: KeyboardEvent): ActionId | null {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return null;
  if (e.key === "Enter") return e.shiftKey ? "admin" : "reveal";
  if (!e.shiftKey) return null;
  switch (e.key.toLowerCase()) {
    case "p":
      return "pin";
    case "c":
      return "copy";
    case "arrowup":
      return "pin-up";
    case "arrowdown":
      return "pin-down";
    default:
      return null;
  }
}
