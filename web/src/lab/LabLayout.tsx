import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { AreaHead, SubNav } from "../components/DeckTabs";
import "./lab.css";

/** The Lab pages, in order. `also` marks deeper pages that belong to an entry. */
const LAB_PAGES: { to: string; label: string; end?: boolean; also?: string }[] = [
  { to: "/decks/lab", label: "Precons", end: true, also: "/decks/lab/p/" },
  { to: "/decks/lab/try", label: "Try a change" },
  { to: "/decks/lab/compare", label: "Compare decks" },
  { to: "/decks/lab/runs", label: "My runs" },
];

/**
 * The head of a Lab page: its title, Decks | Plans | Lab, and the lab's sub-nav. `index` is the
 * precon table (the lab's front page); other pages get a back button on phones, to `back`.
 * `slim` pages (a precon, a run) carry their own heading under it.
 */
export function LabHead({
  title,
  index = false,
  slim = false,
  back = { to: "/decks/lab", label: "Back to the lab" },
  action,
}: {
  title?: ReactNode;
  index?: boolean;
  slim?: boolean;
  back?: { to: string; label: string };
  action?: ReactNode;
}) {
  const { pathname } = useLocation();
  return <AreaHead title={title} index={index} slim={slim} back={back} action={action ?? (index ? <a className="button" href="/precons">Public precons</a> : undefined)} nav={<SubNav label="Lab pages" pages={LAB_PAGES} also={pathname} />} />;
}

/** The Lab section of the Decks tab. Each page draws its own head (LabHead). */
export function LabLayout() {
  return (
    <main className="page lab">
      <Outlet />
    </main>
  );
}
