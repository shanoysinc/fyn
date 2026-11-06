// Small fuzzy matcher for Fyn's built-in commands (apps are matched in Rust with nucleo).

export interface Match {
  score: number;
  /** Matched character indices in the title, for highlighting. */
  matches: number[];
}

const range = (start: number, len: number) => Array.from({ length: len }, (_, i) => start + i);

function isWordStart(text: string, i: number) {
  return i === 0 || /[\s\-_/.()&]/.test(text[i - 1]);
}

/**
 * Score `query` against `title` (highlighted) and `keywords` (not highlighted).
 * Higher is better: prefix 100, word prefix 80, substring 60, keyword 50–70, subsequence ≤40.
 */
export function fuzzyMatch(query: string, title: string, keywords: readonly string[] = []): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const t = title.toLowerCase();

  const idx = t.indexOf(q);
  if (idx === 0) return { score: 100 - t.length * 0.1, matches: range(0, q.length) };
  if (idx > 0) {
    // Prefer a hit at the start of a word over one in the middle of a word.
    let at = idx;
    while (at !== -1 && !isWordStart(t, at)) at = t.indexOf(q, at + 1);
    if (at !== -1) return { score: 80 - t.length * 0.1, matches: range(at, q.length) };
    return { score: 60 - t.length * 0.1, matches: range(idx, q.length) };
  }

  for (const k of keywords) {
    const kw = k.toLowerCase();
    if (kw === q) return { score: 72, matches: [] };
    if (kw.startsWith(q)) return { score: 68, matches: [] };
  }
  for (const k of keywords) {
    if (q.length >= 3 && k.toLowerCase().includes(q)) return { score: 50, matches: [] };
  }

  // Subsequence, e.g. "tdm" -> "Toggle Dark Mode". Rewards word starts and runs.
  const matches: number[] = [];
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += isWordStart(t, found) ? 3 : matches.length && found === matches[matches.length - 1] + 1 ? 2 : 0.5;
    matches.push(found);
    ti = found + 1;
  }
  const quality = score / (q.replace(/ /g, "").length * 3);
  if (quality < 0.5) return null;
  return { score: 20 + quality * 20, matches };
}
