import { Navigate, useLocation } from "react-router";

/**
 * Where an old plan address lives now (Bryan, 2026-11-06: the plans redesign). Plans moved from
 * `/decks/plan` to `/decks/plans`; a deck's plan page from `/decks/plan/d/<key>` to
 * `/decks/plans/<key>`; Review folded into Plans; a research note is an archived plan
 * (`/decks/research/<id>[/<deck>]` to `/decks/plans/archived/<id>[/<deck>]`). Null: not an old
 * address this handles (the page is still where it was).
 */
export function planPath(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, "");
  if (p === "/decks/plan" || p === "/decks/plan/review") return "/decks/plans";
  if (p === "/decks/plan/settings") return "/decks/plans/settings";
  const deck = /^\/decks\/plan\/d\/([^/]+)$/.exec(p);
  if (deck) return `/decks/plans/${deck[1]}`;
  const note = /^\/decks\/research\/([^/]+)(\/[^/]+)?$/.exec(p);
  if (note) return `/decks/plans/archived/${note[1]}${note[2] ?? ""}`;
  return null;
}

/** An old plan link opens the same plan at its new address, query and hash kept; none 404s. */
export function OldPlanRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${planPath(pathname) ?? "/decks/plans"}${search}${hash}`} replace />;
}
