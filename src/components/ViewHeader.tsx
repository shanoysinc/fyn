import type { ReactNode } from "react";

/** Top bar for secondary screens: a back button plus a search field or title. */
export function ViewHeader({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="search">
      <button className="icon-btn back-btn" onClick={onBack} aria-label="Back" title="Back (Esc)">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <path
            d="M15 5l-7 7 7 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {children}
    </div>
  );
}
