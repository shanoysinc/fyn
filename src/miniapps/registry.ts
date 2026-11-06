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
