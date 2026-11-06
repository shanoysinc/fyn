// Mini apps: small built-in tools with their own screen. Add one here and it appears in
// the Mini Apps screen and in search, and can be pinned like any command.

import type { GlyphName, View } from "../lib/entries";

export interface MiniApp {
  id: string;
  title: string;
  description: string;
  glyph: GlyphName;
  tint: string;
  keywords: string[];
  /** The screen it opens. */
  view: View;
}

export const MINI_APPS: MiniApp[] = [
  {
    id: "clean-windows",
    title: "Clean Windows",
    description: "Free up disk space: temp files, caches, crash dumps and more",
    glyph: "broom",
    tint: "#10b981",
    keywords: ["clean", "cleanup", "disk", "space", "storage", "temp", "cache", "free up", "npm", "gradle"],
    view: "clean",
  },
];
