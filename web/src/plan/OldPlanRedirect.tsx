import { Navigate, useLocation } from "react-router";

/**
 * Where an old plan address lives now (Bryan, 2026-11-06: the plans redesign). Plans moved from
 * `/decks/plan` to `/decks/plans`; a deck's plan page from `/decks/plan/d/<key>` to
 * `/decks/plans/<key>`; Review folded into Plans; a research note is an archived plan
 * (`/decks/research/<id>[/<deck>]` to `/decks/plans/archived/<id>[/<deck>]`); Buy, Prints and Spares
 * are steps of Get the cards, and its tools (store trip, MakePlayingCards, swap sheet and cards) are
 * under it. Null: not an old address this handles.
 */
export function planPath(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, "");
  if (p === "/decks/plan" || p === "/decks/plan/review") return "/decks/plans";
  if (p === "/decks/plan/settings") return "/decks/plans/settings";
  const moved: Record<string, string> = {
    "/decks/plan/buy": "/decks/plans/get#buy",
    "/decks/plan/trip": "/decks/plans/get/trip",
    "/decks/plan/prints": "/decks/plans/get#print",
    "/decks/plan/prints/mpc": "/decks/plans/get/mpc",
    "/decks/plan/prints/swap": "/decks/plans/get/swap-sheet",
    "/decks/plan/spares": "/decks/plans/get#move",
    "/decks/plan/swap-cards": "/decks/plans/get/swap-cards",
  };
  if (moved[p]) return moved[p];
  const deck = /^\/decks\/plan\/d\/([^/]+)$/.exec(p);
  if (deck) return ["get", "settings", "archived", "d"].includes(decodeURIComponent(deck[1]!)) ? `/decks/plans/d/${deck[1]}` : `/decks/plans/${deck[1]}`;
  const note = /^\/decks\/research\/([^/]+)(\/[^/]+)?$/.exec(p);
  if (note) return `/decks/plans/archived/${note[1]}${note[2] ?? ""}`;
  return null;
}

/** An old plan link opens the same plan at its new address, query and hash kept; none 404s. */
export function OldPlanRedirect() {
  const { pathname, search, hash } = useLocation();
  const to = planPath(pathname) ?? "/decks/plans";
  // A step's own anchor (#buy) gives way to one the old link carried.
  return <Navigate to={`${to.split("#")[0]}${search}${hash || (to.includes("#") ? `#${to.split("#")[1]}` : "")}`} replace />;
}
