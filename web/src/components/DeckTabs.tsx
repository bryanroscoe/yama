import { NavLink } from "react-router";
import "../lab/lab.css";

/**
 * The Decks tab's sections, in order. The planner branch has the same control with "Plans"
 * (web/src/plan/DeckTabs.tsx); when the branches merge, keep one copy with all three sections.
 */
export const DECK_SECTIONS: { to: string; label: string; end?: boolean }[] = [
  { to: "/decks", label: "Decks", end: true },
  { to: "/decks/lab", label: "Lab" },
];

/** The segmented control at the top of the Decks tab. */
export function DeckTabs() {
  return (
    <nav className="segments" aria-label="Decks sections">
      {DECK_SECTIONS.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end}>
          {s.label}
        </NavLink>
      ))}
    </nav>
  );
}
