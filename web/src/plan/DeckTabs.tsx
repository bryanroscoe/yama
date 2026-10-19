import { NavLink } from "react-router";
import "./plan.css";

/** The Decks tab's sections, in order. Adding a section (the lab's "Lab") is one line here. */
export const DECK_SECTIONS: { to: string; label: string; end?: boolean }[] = [
  { to: "/decks", label: "Decks", end: true },
  { to: "/decks/plan", label: "Plans" },
];

/** The segmented control at the top of the Decks tab. */
export function DeckTabs() {
  return (
    <nav className="segmented deck-sections" aria-label="Decks sections">
      {DECK_SECTIONS.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end}>
          {s.label}
        </NavLink>
      ))}
    </nav>
  );
}
