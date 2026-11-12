// Where to ask for a larger allowance or for Ask Claude: the contact on the About page. (The
// file keeps the name it had when it also held the note for power-user pages, which are gone
// since every account may watch and simulate, 12 Nov 2026: other pages import from it.)

import { publicOrigin } from "../api";

/** The contact on the About page (a server page, so the Android app opens it on the site). */
export function contactHref(): string {
  return `${publicOrigin()}/about/#contact`;
}
