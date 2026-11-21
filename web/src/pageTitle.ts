// The browser's title: "Decks | Yama", "Meren of Clan Nel Toth | Yama", as the server-drawn public
// pages have it (server/src/public_page.rs). Every page used to be "Yama", so tabs, history and
// bookmarks couldn't be told apart.
//
// Three places may name the open page, and the most specific one that has a name wins:
// the frame names it from its address (App.tsx, nav.tsx `titleOf`), a route may give its page's
// heading (lazyPages.tsx, `Paged` and `Framed`), and a page that knows more says so itself:
//
//   usePageTitle(deck.data?.name);   // "Decks | Yama" until the deck has loaded
import { useEffect } from "react";

const SITE = "Yama";

/** The document's title for a page's name; the site's alone for Home or a page with none. */
export function titleFor(name: string | null | undefined): string {
  const words = name?.trim();
  return words ? `${words} | ${SITE}` : SITE;
}

interface Named {
  name: string;
  level: number;
  /** When it was said: of two at one level (a page and a sheet over it), the later. */
  at: number;
}

const named = new Set<Named>();
let said = 0;

function show() {
  let best: Named | undefined;
  for (const n of named) if (!best || n.level > best.level || (n.level === best.level && n.at > best.at)) best = n;
  document.title = titleFor(best?.name);
}

function useTitleAt(name: string | null | undefined, level: number) {
  useEffect(() => {
    const words = name?.trim();
    if (!words) return;
    const mine: Named = { name: words, level, at: ++said };
    named.add(mine);
    show();
    return () => {
      named.delete(mine);
      show();
    };
  }, [name, level]);
}

/** The frame's name for the address: the tab or section it belongs to. */
export const useFrameTitle = (name: string | null | undefined) => useTitleAt(name, 0);

/** A route's own heading, where the route knows it. */
export const useRouteTitle = (name: string | null | undefined) => useTitleAt(name, 1);

/**
 * The page's own name, from what it shows (a deck's, a game's, a card's): set while the page is
 * open, and given back when it closes or the name goes. Nothing happens for no name, so a page
 * still loading keeps the frame's.
 */
export const usePageTitle = (name: string | null | undefined) => useTitleAt(name, 2);
