// Shortcuts are stored in the format the Rust side parses ("Ctrl+Shift+KeyK"),
// using KeyboardEvent.code so they're independent of keyboard layout.

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

export function fromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code) || !e.code) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  parts.push(e.code);
  return parts.join("+");
}

const LABELS: Record<string, string> = {
  Super: "Win",
  Space: "Space",
  Enter: "↵",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** "Ctrl+Shift+KeyK" -> ["Ctrl", "Shift", "K"] */
export function toKeys(accel: string): string[] {
  return accel.split("+").map((part) => {
    if (LABELS[part]) return LABELS[part];
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit\d$/.test(part)) return part.slice(5);
    if (/^Numpad\d$/.test(part)) return `Num ${part.slice(6)}`;
    return part;
  });
}
