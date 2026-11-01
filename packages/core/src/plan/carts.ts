// Carts and lists to paste (docs/shopping-design.md, "Carts and lists"). What each format accepts
// was checked on 1 Nov 2026 against the sites themselves, not guessed:
//
// - Shopify stores (Pat's, Mothership): the cart permalink `https://<shop>/cart/<variant>:<qty>,...`
//   from the store's cart template (`buy.ts` `cartUrl`). It needs each listing's variant id.
// - TCGplayer Pro storefronts (`<store>.tcgplayerpro.com`: Black Castle, Multiverse) have no cart
//   link and no mass entry; the only link is a product search,
//   `/search/products?q=<card>&productLineName=Magic%3A%20The%20Gathering`.
// - TCGplayer Mass Entry (the marketplace, not a store): `https://www.tcgplayer.com/massentry?
//   productline=Magic&c=<line>||<line>`, each line `QTY Name` encoded on its own. A set code in
//   brackets is TCGplayer's own, which may differ from Scryfall's, so lines carry the name only.
//   An 8.3 KB link was refused (414), so a longer list is left to paste.
//
// server/src/plan/trip.rs builds the same links for Claude.

import type { Store } from "./types";

/** Longest Mass Entry link Yama builds; longer lists are pasted instead. */
export const MASS_ENTRY_MAX = 7000;

/** Stores list a double-faced card by its front face. */
export function frontFace(card: string): string {
  return card.split(" // ")[0]!.trim();
}

/** "1 Sol Ring" per card, in order, a repeated card counted once with its quantity. */
export function pasteLines(cards: string[]): string[] {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([c, n]) => `${n} ${c}`);
}

/** The list as plain text, one card a line: most deck sites and stores take it. */
export function pasteText(cards: string[]): string {
  return pasteLines(cards).join("\n");
}

/** A TCGplayer Mass Entry link with these cards, or null when there are none or it would be too long. */
export function massEntryUrl(cards: string[]): string | null {
  if (!cards.length) return null;
  const lines = pasteLines(cards.map(frontFace)).map((l) => encodeURIComponent(l));
  const url = `https://www.tcgplayer.com/massentry?productline=Magic&c=${lines.join("||")}`;
  return url.length <= MASS_ENTRY_MAX ? url : null;
}

/** The store's TCGplayer Pro storefront, when its homepage is one. */
export function proStorefront(store: Pick<Store, "homepage">): string | null {
  try {
    const u = new URL(store.homepage ?? "");
    return u.protocol === "https:" && u.hostname.endsWith(".tcgplayerpro.com") ? u.origin : null;
  } catch {
    return null;
  }
}

/** A search for one card on a TCGplayer Pro storefront, cheapest first. */
export function proSearchUrl(store: Pick<Store, "homepage">, card: string): string | null {
  const base = proStorefront(store);
  return base ? `${base}/search/products?q=${encodeURIComponent(frontFace(card))}&productLineName=${encodeURIComponent("Magic: The Gathering")}&sort=price-asc` : null;
}
