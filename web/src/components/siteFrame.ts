// The public header's and footer's links, the same on every public page. The server renders them
// for its own pages and the static pages carry a copy (server/src/public_page.rs, SITE_NAV and
// SITE_FOOT); Landing.test.tsx holds this list to that one. Styles: public/site-frame-v1.css.

export const SITE_NAV: readonly (readonly [href: string, label: string])[] = [
  ["/precons", "Precons"],
  ["/commanders", "Commanders"],
  ["/docs/mcp/", "MCP guide"],
  ["/about/", "About"],
];

export const SITE_FOOT: readonly (readonly [href: string, label: string])[] = [
  ["/about/", "About"],
  ["/precons/methodology", "How we rank"],
  ["/about/#contact", "Help and contact"],
  ["/privacy/", "Privacy"],
  ["/tos/", "Terms"],
];
