// Buy this deck (the deck page's Stats tab, with its market value): the cards still to get, or
// the whole list, as links that open a store's own list page with the names filled in.
//
// - TCGplayer Mass Entry: `massEntryUrl` (packages/core/src/plan/carts.ts), the planner's link.
// - Card Kingdom's deck builder: `https://www.cardkingdom.com/builder?c=<list>`, the list one
//   `QTY Name` a line. Checked against the site on 11 Nov 2026: the page opens with the list in
//   its box, and took an address of 7.3 KB. Longer lists are left to paste, as for Mass Entry.
//
// Both are US stores. No affiliate or partner codes. The stores choose printings and set their
// own prices; the market prices beside the links are dated references, never a store's quote.
import { frontFace, massEntryUrl, MASS_ENTRY_MAX, pasteLines } from "@yama/core/plan";
import type { DeckEntry } from "../api";
import { isBasic } from "./deckScan";

export type BuyWhat = "need" | "all";

export interface BuyList {
  /** Copies in the list. */
  copies: number;
  /** Known market prices only, each copy at its cheapest printing; null when no copy has one. */
  usd: number | null;
  /** Copies with no price: unknown, not $0. */
  unpriced: number;
  /** The oldest and newest of those prices' dates (YYYY-MM-DD). */
  oldest: string | null;
  newest: string | null;
  /** `1 Sol Ring` a line: what the links carry, and what Copy gives. */
  paste: string;
  /** Null when there is nothing to buy or the list is too long for a link. */
  tcgplayer: string | null;
  cardKingdom: string | null;
}

/** A Card Kingdom deck builder link with these cards, or null when there are none or it would be too long. */
export function cardKingdomUrl(cards: string[]): string | null {
  if (!cards.length) return null;
  const url = `https://www.cardkingdom.com/builder?c=${encodeURIComponent(pasteLines(cards.map(frontFace)).join("\n"))}`;
  return url.length <= MASS_ENTRY_MAX ? url : null;
}

/**
 * What to buy: the copies neither real cards nor proxies cover (basic lands left out, as in the
 * deck's "Still to get"), or every card of the commander and main deck. Never the sideboard.
 */
export function buyList(cards: DeckEntry[], what: BuyWhat): BuyList {
  const names: string[] = [];
  const dates: string[] = [];
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const e of cards) {
    if (e.board !== "commander" && e.board !== "main") continue;
    const n = what === "all" ? e.qty : isBasic(e.name) ? 0 : Math.max(0, e.qty - e.owned - e.proxies);
    if (n <= 0) continue;
    for (let i = 0; i < n; i++) names.push(e.name);
    if (e.cheapest_usd == null) unpriced += n;
    else {
      usd += e.cheapest_usd * n;
      priced += n;
      if (e.cheapest_printing?.date) dates.push(e.cheapest_printing.date);
    }
  }
  dates.sort();
  return {
    copies: names.length,
    usd: priced ? Math.round(usd * 100) / 100 : null,
    unpriced,
    oldest: dates[0] ?? null,
    newest: dates.at(-1) ?? null,
    paste: pasteLines(names.map(frontFace)).join("\n"),
    tcgplayer: massEntryUrl(names),
    cardKingdom: cardKingdomUrl(names),
  };
}
