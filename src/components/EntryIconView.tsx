import type { ReactNode } from "react";
import type { EntryIcon, GlyphName } from "../lib/entries";
import { AppIcon } from "./AppIcon";

/** Symmetric 8-tooth gear outline (Lucide "settings", ISC licence); pair with a r=3 centre circle. */
export const GEAR_PATH =
  "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z";

// 24×24 stroke icons drawn on a tinted tile, so built-in commands sit nicely next to app icons.
const PATHS: Record<GlyphName, ReactNode> = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  restart: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4.5h4.5" />
    </>
  ),
  power: (
    <>
      <path d="M12 3v8" />
      <path d="M7 6.3a7.5 7.5 0 1 0 10 0" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M10 8l-4 4 4 4M6 12h10" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </>
  ),
  contrast: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
    </>
  ),
  emoji: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 14a4 4 0 0 0 7 0M9.5 9.5h.01M14.5 9.5h.01" />
    </>
  ),
  droplet: <path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z" />,
  gear: (
    <>
      <path d={GEAR_PATH} />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  sparkle: <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" />,
  download: (
    <>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 19h14" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8c-2.2-2.3-3.2-5-3.2-8s1-5.7 3.2-8Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  folder: <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  calculator: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 7h8M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01" />
    </>
  ),
  sliders: <path d="M5 7h9M18 7h1M5 17h1M10 17h9M16 5v4M8 15v4" />,
  clipboard: (
    <>
      <path d="M8.5 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1.5" />
      <rect x="8.5" y="3" width="7" height="4" rx="1.2" />
      <path d="M8.5 12h7M8.5 16h4.5" />
    </>
  ),
  sparkles: (
    <>
      <path d="M10 4.5l1.6 4.4 4.4 1.6-4.4 1.6L10 16.5l-1.6-4.4L4 10.5l4.4-1.6Z" />
      <path d="M18 14v5M15.5 16.5h5" />
      <path d="M17.5 3.5v3M16 5h3" />
    </>
  ),
  eyedropper: (
    <>
      <path d="M13.5 6.5l1.8-1.8a2.3 2.3 0 0 1 3.3 3.3l-1.8 1.8" />
      <path d="M11.5 7.5l5 5" />
      <path d="M14 10l-7.3 7.3a2 2 0 0 1-1 .55L4 18.3l.45-1.7a2 2 0 0 1 .55-1L12.3 8.3" />
    </>
  ),
  text: <path d="M5 7h14M5 12h14M5 17h9" />,
  broom: (
    <>
      <path d="M19 5l-7.5 7.5" />
      <path d="M9.5 11.5l3 3-2.2 4.4a1 1 0 0 1-1.6.3l-4-4a1 1 0 0 1 .3-1.6Z" />
      <path d="M7 15.5l1.5 1.5" />
    </>
  ),
  apps: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="2" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="3.25" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="2" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" />
    </>
  ),
  doc: (
    <>
      <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3.5V8h4.5M9 12.5h6M9 16h4" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
};

export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

export function EntryIconView({ icon }: { icon: EntryIcon }) {
  switch (icon.kind) {
    case "app":
      return <AppIcon item={icon.item} />;
    case "glyph":
      if (icon.gradient) return <MiniAppIcon glyph={icon.glyph} gradient={icon.gradient} />;
      return (
        <span className="glyph-tile" style={{ background: icon.tint }}>
          <Glyph name={icon.glyph} size={15} />
        </span>
      );
    case "swatch":
      return <span className="glyph-tile glyph-tile--swatch" style={{ background: icon.color }} />;
  }
}

/**
 * App-style icon for mini apps: a rounded tile with a gradient, a soft highlight along
 * the top and a small shadow, with a bold white symbol. Scales with its container
 * (24px in lists, 40px in the icon row, 46px on the Mini Apps screen).
 */
export function MiniAppIcon({ glyph, gradient, size = 15 }: { glyph: GlyphName; gradient: [string, string]; size?: number }) {
  return (
    <span
      className="mini-icon"
      style={{ "--from": gradient[0], "--to": gradient[1] } as React.CSSProperties}
    >
      <Glyph name={glyph} size={size} />
    </span>
  );
}
