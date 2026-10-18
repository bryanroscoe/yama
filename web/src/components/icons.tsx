// Simple line icons, 24px grid.
const s = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const TableIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...s}><path d="M12 21s-7-4.5-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.5-7 11-7 11z" /></svg>
);
export const CardsIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...s}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></svg>
);
export const CollectionIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...s}><rect x="4" y="5" width="10" height="14" rx="1.5" /><path d="M17 7v12M20 9v8" /></svg>
);
export const DecksIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...s}><rect x="6" y="3" width="12" height="16" rx="1.5" /><path d="M4 7v12a2 2 0 0 0 2 2h10" /></svg>
);
export const GroupIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...s}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></svg>
);
export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...s}><rect x="3" y="6" width="8" height="12" rx="1.5" transform="rotate(-8 7 12)" /><rect x="13" y="6" width="8" height="12" rx="1.5" transform="rotate(8 17 12)" /></svg>
);
