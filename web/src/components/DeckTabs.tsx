import { NavLink } from "react-router";

/** The Decks tab's sections, in order. Adding a section is one line here. */
export const DECK_SECTIONS: { to: string; label: string; end?: boolean }[] = [
  { to: "/decks", label: "Decks", end: true },
  { to: "/decks/plan", label: "Plans" },
  { to: "/decks/lab", label: "Lab" },
];

/** The segmented control at the top of the Decks tab: the Decks list, the plan pages and the lab
 *  pages all show it. Drawn as the shared .segmented pill (styles.css). */
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
