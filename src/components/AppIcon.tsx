import { memo, useState } from "react";
import { iconUrl, type Item } from "../lib/ipc";

const TINTS = ["#ff6a5b", "#f5a524", "#17c964", "#06b7db", "#7c5cff", "#e2315f", "#3b82f6"];

function tint(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

/** Icons that have loaded once; they appear instantly afterwards (no fade while typing). */
const seen = new Set<string>();

/**
 * App icon that never "pops": the first time an image loads it fades in, and the
 * coloured letter is only used when there's no icon at all or it fails to load.
 * (Showing the letter first and swapping it for the image made rows flash on startup.)
 */
export const AppIcon = memo(function AppIcon({ item }: { item: Pick<Item, "icon" | "name"> }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  if (item.icon && failed !== item.icon) {
    const icon = item.icon;
    const ready = loaded === icon || seen.has(icon);
    return (
      <img
        className={`app-icon ${ready ? "app-icon--loaded" : ""}`}
        src={iconUrl(icon)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => {
          seen.add(icon);
          setLoaded(icon);
        }}
        onError={() => setFailed(icon)}
      />
    );
  }
  return (
    <span className="app-icon app-icon--fallback" style={{ background: tint(item.name) }}>
      {item.name.charAt(0).toUpperCase()}
    </span>
  );
});
