import { NavLink } from "react-router";
import { publicOrigin } from "../api";

/** Public destinations and your sharing library stay reachable from every app section. */
export function SiteLinks() {
  const origin = publicOrigin();
  return <nav className="site-links" aria-label="Sharing and public pages">
    <NavLink to="/sharing">Sharing</NavLink>
    <a href={`${origin}/precons`}>Precons</a>
    <a href={`${origin}/commanders`}>Commanders</a>
    <a href={`${origin}/docs/mcp/`}>MCP guide</a>
  </nav>;
}
