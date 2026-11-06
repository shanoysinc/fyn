// Mini apps: small built-in tools with their own screen. Add one here and it appears in
// the Mini Apps screen and in search, and can be pinned to Favorites like any command.
//
// `id` is part of the pin id ("cmd:fyn:<id>"), so don't rename it once shipped:
// clipboard / emoji / color keep the ids they had as plain commands, so existing
// favorites survive.

import type { GlyphName, View } from "../lib/entries";

export interface MiniApp {
  id: string;
  title: string;
  description: string;
  glyph: GlyphName;
  /** App-icon gradient, light to dark. */
  gradient: [string, string];
  keywords: string[];
  /** The screen it opens. */
  view: View;
}

export const MINI_APPS: MiniApp[] = [
  {
    id: "clipboard",
    title: "Clipboard History",
    description: "Search and paste text and images you copied",
    glyph: "clipboard",
    gradient: ["#818cf8", "#4f46e5"],
    keywords: ["clipboard", "paste", "copied", "history", "copy"],
    view: "clipboard",
  },
  {
    id: "clean-windows",
    title: "Clean Windows",
    description: "Free up disk space: temp files, caches, crash dumps and more",
    glyph: "sparkles",
    gradient: ["#34d399", "#059669"],
    keywords: ["clean", "cleanup", "disk space", "free space", "free up", "storage", "temp", "cache", "npm", "gradle"],
    view: "clean",
  },
  {
    id: "pomodoro",
    title: "Pomodoro",
    description: "Focus in 25-minute sessions, with breaks, history and stats",
    glyph: "timer",
    gradient: ["#fb7185", "#e11d48"],
    keywords: ["pomodoro", "focus", "timer", "tomato", "break", "productivity", "concentrate"],
    view: "pomodoro",
  },
  {
    id: "ports",
    title: "Port Killer",
    description: "See what's listening on each port and stop it",
    glyph: "plug",
    gradient: ["#2dd4bf", "#0f766e"],
    keywords: ["port", "kill port", "localhost", "listening", "process", "address in use", "3000", "netstat"],
    view: "ports",
  },
  {
    id: "passwords",
    title: "Password Generator",
    description: "Strong passwords and passphrases, copied privately",
    glyph: "key",
    gradient: ["#94a3b8", "#334155"],
    keywords: ["password", "passphrase", "generate password", "random", "secure", "secret"],
    view: "passwords",
  },
  {
    id: "devtools",
    title: "Dev Tools",
    description: "JSON, Base64, URL encoding, UUIDs, timestamps and hashes",
    glyph: "code",
    gradient: ["#60a5fa", "#1d4ed8"],
    keywords: ["json", "format json", "base64", "encode", "decode", "url encode", "uuid", "guid", "timestamp", "epoch", "sha256", "hash", "developer"],
    view: "devtools",
  },
  {
    id: "color",
    title: "Color Picker",
    description: "Pick a color from anywhere on screen and convert it",
    glyph: "eyedropper",
    gradient: ["#f472b6", "#f97316"],
    keywords: ["pick color", "colour", "eyedropper", "hex", "rgb", "hsl"],
    view: "color",
  },
  {
    id: "emoji",
    title: "Emoji Picker",
    description: "Find an emoji and copy it",
    glyph: "emoji",
    gradient: ["#fcd34d", "#f59e0b"],
    keywords: ["emoji", "emoticon", "symbols", "smiley", "search emoji"],
    view: "emoji",
  },
];
