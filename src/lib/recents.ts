// Small "recently used" lists (emoji, colours) kept in localStorage.
// Storage can be unavailable; every access is guarded so the UI works without it.

export function loadRecents(key: string): string[] {
  try {
    const raw = localStorage.getItem(`fyn:recent:${key}`);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecent(key: string, value: string, max = 16): string[] {
  const list = [value, ...loadRecents(key).filter((v) => v !== value)].slice(0, max);
  try {
    localStorage.setItem(`fyn:recent:${key}`, JSON.stringify(list));
  } catch {
    // Not persisted; still returned for this session.
  }
  return list;
}
