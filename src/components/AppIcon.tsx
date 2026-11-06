import { memo, useState } from "react";
import { iconUrl, type Item } from "../lib/ipc";

const TINTS = ["#ff6a5b", "#f5a524", "#17c964", "#06b7db", "#7c5cff", "#e2315f", "#3b82f6"];

function tint(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

export const AppIcon = memo(function AppIcon({ item }: { item: Pick<Item, "icon" | "name"> }) {
  const [failed, setFailed] = useState(false);
  if (item.icon && !failed) {
    return (
      <img
        className="app-icon"
        src={iconUrl(item.icon)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="app-icon app-icon--fallback" style={{ background: tint(item.name) }}>
      {item.name.charAt(0).toUpperCase()}
    </span>
  );
});
