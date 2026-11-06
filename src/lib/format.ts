// Small formatting helpers shared by screens.

/** 1536 -> "2 KB", 2_400_000 -> "2.3 MB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Unix seconds -> "Just now", "5m ago", "3h ago", "Yesterday", "4d ago". */
export function relativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - unixSeconds));
  if (s < 45) return "Just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  const days = Math.round(s / 86_400);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}
