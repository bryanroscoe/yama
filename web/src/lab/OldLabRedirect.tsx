import { Navigate, useLocation } from "react-router";

/** `/decks/lab/runs/x` to `/lab/runs/x` and `/decks/datasets/x` to `/lab/datasets/x`; anything
 *  else goes to the Lab's front page. */
export function labPath(pathname: string): string {
  if (pathname.startsWith("/decks/lab")) return pathname.slice("/decks".length);
  if (pathname.startsWith("/decks/datasets")) return `/lab${pathname.slice("/decks".length)}`;
  return "/lab";
}

/** The Lab was a section of Decks until 2026-10-28, and Datasets until 2026-11-04: an old link
 *  opens the same page under `/lab`, query and hash kept. The server redirects these too
 *  (routes.rs). */
export function OldLabRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${labPath(pathname)}${search}${hash}`} replace />;
}
