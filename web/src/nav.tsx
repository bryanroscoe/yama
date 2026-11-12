// Yama's top-level navigation, in one table (Bryan, 12 Nov 2026: one frame for the app and the
// public pages). The laptop rail, the phone's bottom tabs and the strip of a tab's pages read it.
// The server's public pages still have their own header (server/src/public_page.rs); giving them
// these tabs is a later change.
//
// Home (`/`) belongs to no tab: the wordmark goes there. Adding a page to a tab is one line in
// that tab's `sections` (or `owns`, for a page that isn't listed). Nothing here changes an
// address: a page moves between tabs by changing which tab its address belongs to.
import type { ReactNode } from "react";
import { CardsIcon, CollectionIcon, DecksIcon, GroupIcon, PlayIcon, WorkshopIcon } from "./components/icons";

export type TabId = "play" | "decks" | "cards" | "collection" | "playgroup" | "workshop" | "you";

/** What the frame knows about whoever is looking, to decide which sections to list. */
export interface Who {
  signedIn: boolean;
  /** An admin or a power user. Nothing in the frame depends on it since every account may watch
   *  the computer play and start a simulation (12 Nov 2026); Ask Claude is not a page. */
  power: boolean;
  /** Has imported datasets to browse, or may upload one. */
  evidence: boolean;
}

export interface NavSection {
  to: string;
  label: string;
  /** Only this address, not the pages under it (a deck's page isn't the deck list). */
  end?: boolean;
  /** Other addresses that belong to this section, each with the pages under it. */
  also?: string[];
  /** A page the server draws outside the app (the public precon and commander reference). */
  page?: boolean;
  /** Listed only for whom this says; everyone when absent. */
  when?: (who: Who) => boolean;
  /** Online play is in alpha, said wherever it is reached (components/AlphaTag.tsx). */
  alpha?: boolean;
}

export interface NavTab {
  id: TabId;
  /** Where the tab opens. */
  to: string;
  label: string;
  icon: ReactNode;
  /** Addresses that belong to the tab without being one of its sections. */
  owns?: string[];
  /** The tab's pages, in order. A tab with one page has no strip. */
  sections: NavSection[];
}

const signedIn = (w: Who) => w.signedIn;
const signedOut = (w: Who) => !w.signedIn;

export const TABS: NavTab[] = [
  {
    id: "play",
    to: "/play/table",
    label: "Play",
    icon: <PlayIcon />,
    owns: ["/table", "/play"],
    sections: [
      { to: "/play/table", label: "Life counter" },
      { to: "/play", label: "Play online", end: true, alpha: true },
      { to: "/play/watch", label: "Watch", end: true, when: signedIn },
      { to: "/table/games", label: "Game history", when: signedIn },
    ],
  },
  {
    id: "decks",
    to: "/decks",
    label: "Decks",
    icon: <DecksIcon />,
    owns: ["/decks"],
    sections: [
      { to: "/decks", label: "My decks", end: true, also: ["/decks/import", "/decks/changes"] },
      // The decks people made public (browse/Browse.tsx): open to everyone.
      { to: "/decks/browse", label: "Browse" },
      // Signed in, the precon table with your own results; signed out, the public reference.
      { to: "/lab", label: "Precons", end: true, also: ["/lab/p"], when: signedIn },
      { to: "/precons", label: "Precons", page: true, when: signedOut },
      { to: "/commanders", label: "Commanders", page: true },
      // Open to everyone: a pasted list checked without an account (check/).
      { to: "/check", label: "Check a deck" },
    ],
  },
  { id: "cards", to: "/cards", label: "Cards", icon: <CardsIcon />, sections: [{ to: "/cards", label: "Search" }] },
  {
    id: "collection",
    to: "/collection",
    label: "Collection",
    icon: <CollectionIcon />,
    sections: [
      { to: "/collection", label: "Cards", end: true },
      { to: "/collection/trade", label: "Trade with a friend", also: ["/sharing/compare"] },
    ],
  },
  { id: "playgroup", to: "/group", label: "Playgroup", icon: <GroupIcon />, owns: ["/mythic"], sections: [{ to: "/group", label: "Playgroup" }] },
  {
    id: "workshop",
    to: "/decks/plans",
    label: "Workshop",
    icon: <WorkshopIcon />,
    owns: ["/decks/plans"],
    sections: [
      { to: "/decks/plans", label: "Plans", end: true, also: ["/decks/plans/archived", "/decks/plans/settings", "/decks/research", "/decks/plan"] },
      { to: "/decks/plans/get", label: "Get the cards" },
      { to: "/decks/builds", label: "Swap cards" },
      { to: "/lab/try", label: "Try a change" },
      { to: "/lab/compare", label: "Compare decks" },
      { to: "/lab/runs", label: "Lab runs" },
      { to: "/lab/datasets", label: "Datasets", when: (w) => w.evidence },
    ],
  },
  // The avatar. Its page is the menu, so it has no strip (pages/Profile.tsx).
  { id: "you", to: "/profile", label: "You", icon: null, owns: ["/sharing", "/new", "/admin"], sections: [{ to: "/profile", label: "You" }] },
];

/** The five tabs of the phone's bottom bar and the public header, in order. */
export const MAIN_TABS: TabId[] = ["play", "decks", "cards", "collection", "playgroup"];

export const tab = (id: TabId): NavTab => TABS.find((t) => t.id === id)!;

/** Whether `path` is the address `at` or a page under it. */
function under(path: string, at: string): boolean {
  return path === at || path.startsWith(`${at}/`);
}

/** Whether the page at `pathname` is `at` or under it (a trailing slash doesn't matter). */
export function holdsPath(pathname: string, at: string): boolean {
  return under(pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname, at);
}

/** How closely a section holds `path`: the length of the address that matched, or 0. */
function holds(s: NavSection, path: string): number {
  if (s.page) return 0;
  const own = s.end ? path === s.to : under(path, s.to);
  const also = s.also?.filter((a) => under(path, a)).map((a) => a.length) ?? [];
  return Math.max(own ? s.to.length : 0, ...also);
}

/** The tab a page belongs to: the one holding the longest address that matches. */
export function tabOf(pathname: string): NavTab | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: NavTab | null = null;
  let length = 0;
  for (const t of TABS) {
    const owned = t.owns?.filter((o) => under(path, o)).map((o) => o.length) ?? [];
    const n = Math.max(...t.sections.map((s) => holds(s, path)), ...owned, 0);
    if (n > length) {
      best = t;
      length = n;
    }
  }
  return best;
}

/** A tab's sections as `who` sees them. */
export function sectionsFor(t: NavTab, who: Who): NavSection[] {
  return t.sections.filter((s) => !s.when || s.when(who));
}

/** The section of `t` a page is in, if it is one of the tab's own pages (not a deck's, say). */
export function sectionOf(t: NavTab, pathname: string, who: Who): NavSection | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: NavSection | null = null;
  let length = 0;
  for (const s of sectionsFor(t, who)) {
    const n = holds(s, path);
    if (n > length) {
      best = s;
      length = n;
    }
  }
  return best;
}
