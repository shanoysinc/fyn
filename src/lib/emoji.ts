// Emoji catalogue: names/groups from unicode-emoji-json, search keywords from emojilib.
// Loaded lazily with the emoji picker so it never slows down opening the launcher.

import keywordMap from "emojilib";
import data from "unicode-emoji-json/data-by-emoji.json";

export interface Emoji {
  char: string;
  name: string;
  group: string;
  keywords: string[];
}

const raw = data as Record<string, { name: string; group: string }>;

export const EMOJI: Emoji[] = Object.entries(raw).map(([char, e]) => ({
  char,
  name: e.name,
  group: e.group,
  keywords: (keywordMap[char] ?? []).map((k) => k.replace(/_/g, " ").toLowerCase()),
}));

const BY_CHAR = new Map(EMOJI.map((e) => [e.char, e]));

export function emojiByChar(char: string): Emoji | undefined {
  return BY_CHAR.get(char);
}

export const GROUPS: string[] = [...new Set(EMOJI.map((e) => e.group))];

export function searchEmoji(query: string): Emoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return EMOJI;
  const scored: { e: Emoji; s: number }[] = [];
  for (const e of EMOJI) {
    let s = 0;
    if (e.name === q) s = 5;
    else if (e.name.startsWith(q)) s = 4;
    else if (e.name.split(" ").some((w) => w.startsWith(q))) s = 3;
    else if (e.keywords.some((k) => k.startsWith(q))) s = 2;
    else if (q.length >= 2 && (e.name.includes(q) || e.keywords.some((k) => k.includes(q)))) s = 1;
    if (s) scored.push({ e, s });
  }
  // Stable sort keeps Unicode order within each score, which groups similar emoji.
  return scored.sort((a, b) => b.s - a.s).map((x) => x.e);
}
