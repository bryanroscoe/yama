import { Navigate, useLocation } from "react-router";

/** `/decks/lab/runs/x` to `/lab/runs/x`; anything else goes to the Lab's front page. */
export function labPath(pathname: string): string {
  return pathname.startsWith("/decks/lab") ? pathname.slice("/decks".length) : "/lab";
}

/** The Lab was a section of Decks until 2026-10-28: an old `/decks/lab/...` link opens the same
 *  page under `/lab`, query and hash kept. The server redirects these too (routes.rs). */
export function OldLabRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${labPath(pathname)}${search}${hash}`} replace />;
}
