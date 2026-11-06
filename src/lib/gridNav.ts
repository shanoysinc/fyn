// Arrow-key movement for a list that mixes horizontal icon rows (Favorites, Suggestions)
// with ordinary one-item-per-line rows (Applications).
//
// `rows` is the visual layout top to bottom: an icon row is one entry with several values,
// a list item is an entry with a single value.

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface GridMove {
  value: string;
  /** Column to aim for on later up/down moves (kept while passing through list rows). */
  column: number;
}

/**
 * Where an arrow key should move the selection, or null to leave it to the default
 * handling (cmdk: wrap around at the ends; left/right do nothing in a list).
 */
export function gridMove(rows: string[][], selected: string, key: ArrowKey, column: number): GridMove | null {
  const r = rows.findIndex((row) => row.includes(selected));
  if (r === -1) return null;
  const row = rows[r];
  const c = row.indexOf(selected);

  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (row.length < 2) return null;
    const next = Math.max(0, Math.min(row.length - 1, c + (key === "ArrowLeft" ? -1 : 1)));
    return { value: row[next], column: next };
  }

  const target = rows[r + (key === "ArrowUp" ? -1 : 1)];
  if (!target) return null;
  // In an icon row, remember the column; in a list row, keep the one we came in with.
  const aim = row.length > 1 ? c : column;
  const next = Math.min(aim, target.length - 1);
  return { value: target[next], column: aim };
}
