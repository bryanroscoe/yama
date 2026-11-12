// The public footer's links, the same on every public page. The server renders them for its own
// pages and the static pages carry a copy (server/src/public_page.rs, SITE_FOOT); Landing.test.tsx
// holds this list to that one. The header is Yama's frame: its tabs come from nav.tsx (the
// server's SITE_TABS, held to it by nav.test.tsx). Styles: public/site-frame-v1.css.

export const SITE_FOOT: readonly (readonly [href: string, label: string])[] = [
  ["/about/", "About"],
  ["/docs/mcp/", "Connect an assistant"],
  ["/precons/methodology", "How we rank"],
  ["/about/#contact", "Help and contact"],
  ["/privacy/", "Privacy"],
  ["/tos/", "Terms"],
];
