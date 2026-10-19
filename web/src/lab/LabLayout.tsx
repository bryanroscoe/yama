import { NavLink, Outlet, useLocation } from "react-router";
import { DeckTabs } from "../components/DeckTabs";
import "./lab.css";

/** The Lab pages, in order. `also` marks deeper pages that belong to an entry. */
const LAB_PAGES: { to: string; label: string; end?: boolean; also?: string }[] = [
  { to: "/decks/lab", label: "Precons", end: true, also: "/decks/lab/p/" },
  { to: "/decks/lab/try", label: "Try a change" },
  { to: "/decks/lab/runs", label: "My runs" },
];

/** The Lab section of the Decks tab: the segmented control, the lab's sub-nav, then the page. */
export function LabLayout() {
  const { pathname } = useLocation();
  return (
    <main className="page lab">
      <DeckTabs />
      <nav className="lab-subnav" aria-label="Lab pages">
        {LAB_PAGES.map((p) => (
          <NavLink key={p.to} to={p.to} end={p.end} className={({ isActive }) => (isActive || (p.also && pathname.startsWith(p.also)) ? "active" : "")}>
            {p.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </main>
  );
}
