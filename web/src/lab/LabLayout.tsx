import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { AreaHead, SubNav } from "../components/DeckTabs";
import "./lab.css";

/** The Lab pages, in order. `also` marks deeper pages that belong to an entry. */
const LAB_PAGES: { to: string; label: string; end?: boolean; also?: string }[] = [
  { to: "/lab", label: "Precons", end: true, also: "/lab/p/" },
  { to: "/lab/try", label: "Try a change" },
  { to: "/lab/compare", label: "Compare decks" },
  { to: "/lab/runs", label: "My runs" },
];

/**
 * The head of a Lab page: its title and the lab's sub-nav (the Lab is its own tab since
 * 2026-10-28, so there is no Decks | Plans control here). `index` is the
 * precon table (the lab's front page); other pages get a back button on phones, to `back`.
 * `slim` pages (a precon, a run) carry their own heading under it.
 */
export function LabHead({
  title,
  index = false,
  slim = false,
  back = { to: "/lab", label: "Back to the lab" },
  action,
}: {
  title?: ReactNode;
  index?: boolean;
  slim?: boolean;
  back?: { to: string; label: string };
  action?: ReactNode;
}) {
  const { pathname } = useLocation();
  return <AreaHead title={title} index={index} slim={slim} back={back} area="Lab" sections={null} action={action ?? (index ? <a className="button" href="/precons">Public precons</a> : undefined)} nav={<SubNav label="Lab pages" pages={LAB_PAGES} also={pathname} />} />;
}

/** The Lab tab (`/lab`). Each page draws its own head (LabHead). */
export function LabLayout() {
  return (
    <main className="page lab">
      <Outlet />
    </main>
  );
}
