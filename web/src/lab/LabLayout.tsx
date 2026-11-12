import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { useMe, usePower } from "../auth";
import { datasets } from "../datasets/api";
import { AreaHead, SubNav } from "../components/DeckTabs";
import "./lab.css";
import { ButtonLink } from "../components/ui";

/** The Lab pages, in order. `also` marks deeper pages that belong to an entry. */
/** `power`: starts simulations, so admins and power users only. `evidence`: the account's own
 *  imported datasets (Playgroup.gg, Mythic Tools), shown to admins, who can upload one, and to
 *  accounts that have one. They were a section of Decks until 2026-11-04. */
const LAB_PAGES: { to: string; label: string; end?: boolean; also?: string; power?: boolean; evidence?: boolean }[] = [
  { to: "/lab", label: "Precons", end: true, also: "/lab/p/" },
  { to: "/lab/try", label: "Try a change", power: true },
  { to: "/lab/compare", label: "Compare decks", power: true },
  { to: "/lab/runs", label: "My runs" },
  { to: "/lab/datasets", label: "Datasets", evidence: true },
];

/** Whether this account has datasets to browse or may upload one. Shares the Datasets page's
 *  query, so opening it costs nothing more. */
function useEvidence(): boolean {
  const me = useMe().data;
  const admin = !!me?.is_admin && !me.viewing;
  const list = useQuery({ queryKey: ["datasets", me?.id], queryFn: datasets, enabled: !!me && !admin, staleTime: 5 * 60_000 });
  return admin || !!list.data?.length;
}

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
  const power = usePower();
  const evidence = useEvidence();
  // The Datasets page lists itself while open, even for an account the sub-nav would leave it out for.
  const pages = LAB_PAGES.filter((p) => (power || !p.power) && (evidence || !p.evidence || pathname.startsWith(p.to)));
  return <AreaHead title={title} index={index} slim={slim} back={back} area="Lab" sections={null} action={action ?? (index ? <ButtonLink href="/precons">Public precons</ButtonLink> : undefined)} nav={<SubNav label="Lab pages" pages={pages} also={pathname} />} />;
}

/** The Lab tab (`/lab`). Each page draws its own head (LabHead). */
export function LabLayout() {
  return (
    <main className="page lab">
      <Outlet />
    </main>
  );
}
