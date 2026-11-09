import { NavLink } from "react-router";
import { useMe } from "../auth";
import { publicOrigin } from "../api";

/** Public destinations and your sharing library stay reachable from every app section. */
export function SiteLinks() {
  const me = useMe();
  const origin = publicOrigin();
  return <nav className="site-links" aria-label="Sharing and public pages">
    {me.data && <NavLink to="/profile">Your profile</NavLink>}
    <NavLink to="/sharing">Sharing</NavLink>
    <a href={`${origin}/precons`}>Precons</a>
    <a href={`${origin}/commanders`}>Commanders</a>
  </nav>;
}
