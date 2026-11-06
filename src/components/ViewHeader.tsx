import type { ReactNode } from "react";

/** Chevron back button used by every secondary screen. */
export function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="back-btn" onClick={onBack} aria-label="Back" title="Back (Esc)">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Top bar for secondary screens: a back button plus a search field or title. */
export function ViewHeader({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="search">
      <BackButton onBack={onBack} />
      {children}
    </div>
  );
}
