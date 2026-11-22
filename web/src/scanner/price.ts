// The prices the scanner shows for what it filed (Bryan, 15 Nov 2026: "Recent" should say what each
// card is worth), and which card counts as worth a second look. A printing's market price is the
// one for its finish, dated. A missing price stays missing: never $0, never "worth it", and left
// out of a total, which says how many were (AGENTS.md: a missing price stays missing).

import { pickFinish } from "@yama/core";
import type { Printing } from "../api";

/** One printing's market prices by finish, and their date. */
export interface Prices {
  usd: number | null;
  usd_foil: number | null;
  usd_etched: number | null;
  date: string | null;
}

export type ScanFinish = "nonfoil" | "foil" | "etched" | "proxy";

/**
 * The finish a copy of a printing is filed in, given the one chosen last: a proxy stays a proxy;
 * otherwise its only finish, else the chosen one if it comes that way, else regular (`pickFinish`).
 */
export function filedFinish(finishes: string[] | null | undefined, chosen: ScanFinish): ScanFinish {
  return chosen === "proxy" ? "proxy" : (pickFinish({ finishes }, chosen) as ScanFinish);
}

export const pricesOf = (p: Pick<Printing, "usd" | "usd_foil" | "usd_etched" | "price_date">): Prices => ({ usd: p.usd, usd_foil: p.usd_foil, usd_etched: p.usd_etched, date: p.price_date });

/** The market price of one copy in this finish; null when there's none (or a proxy, which has no market price). */
export function priceFor(prices: Prices | null | undefined, finish: ScanFinish): number | null {
  if (!prices || finish === "proxy") return null;
  const v = finish === "foil" ? prices.usd_foil : finish === "etched" ? prices.usd_etched : prices.usd;
  return v != null && Number.isFinite(v) ? v : null;
}

/** Worth the louder sound: a known price at or over the threshold. A missing price never is. */
export const worthIt = (price: number | null, threshold: number) => price != null && Number.isFinite(threshold) && price >= threshold;

/** Tie by price: the dearest of printings within this share of each other (CardVision's 15%). */
export const TIE_WITHIN = 0.15;

/**
 * Tie by price (docs/plans/scanner-match-cardvision.md, item 26; opt-in): among printings the
 * scanner couldn't tell apart, the dearest, when every one of them has a market price in the finish
 * it would be filed in and the dearest is at most TIE_WITHIN above the cheapest. English printings
 * only when there are any (as choosePrinting prefers them). None for a proxy, with fewer than two
 * printings, or with any price missing: a missing price is unknown, never close to another. Equal
 * prices keep the list's order (newest first).
 */
export function priceTie<P extends Pick<Printing, "scryfall_id" | "lang" | "finishes" | "usd" | "usd_foil" | "usd_etched" | "price_date">>(
  printings: readonly P[],
  chosen: ScanFinish,
): { printing: P; low: number; high: number } | null {
  if (chosen === "proxy") return null;
  const english = printings.filter((p) => p.lang === "en");
  const pool = english.length > 0 ? english : printings;
  if (pool.length < 2) return null;
  let best: { printing: P; price: number } | null = null;
  let low = Infinity;
  for (const p of pool) {
    const v = priceFor(pricesOf(p), filedFinish(p.finishes, chosen));
    if (v == null || v <= 0) return null;
    low = Math.min(low, v);
    if (!best || v > best.price) best = { printing: p, price: v };
  }
  if (!best || best.price > low * (1 + TIE_WITHIN)) return null;
  return { printing: best.printing, low, high: best.price };
}

/** A card the scanner filed this session, as its strip shows it (ScanTray.tsx). */
export interface RecentCard {
  /** Stable key (the host's entry). */
  key: string;
  name: string;
  set?: string;
  number?: string;
  finish: ScanFinish;
  copies: number;
  prices?: Prices | null;
  /** The printing's small picture, for its tile in the strip (ScanTray.tsx). */
  image?: string | null;
  /** The card's oracle id, for its playability tag (playable.ts). */
  oracleId?: string;
  /**
   * Its write isn't confirmed yet ("saving"); the add failed ("failed", it may not be in the
   * collection); a change to it failed ("change-failed"). Card first, printing after: its printing
   * is being worked out ("finding") or waits for a pick ("pick"); nothing of it is saved yet.
   */
  state?: "saving" | "failed" | "change-failed" | "finding" | "pick";
  /** Filed as the dearest of printings the scanner couldn't tell apart (Tie by price). */
  byPrice?: boolean;
}

/** A tile whose printing isn't settled yet (card first, printing after): no price, not in the collection. */
export const unsettledTile = (c: Pick<RecentCard, "state">) => c.state === "finding" || c.state === "pick";

/** The session's total market value: priced copies only, and how many cards (not proxies) had no price. */
export function sessionTotal(cards: readonly RecentCard[]): { total: number; priced: number; missing: number } {
  let total = 0;
  let priced = 0;
  let missing = 0;
  for (const c of cards) {
    // No printing yet, so no price to have: not "unpriced" either (trayTotal says how many wait).
    if (c.finish === "proxy" || unsettledTile(c)) continue;
    const p = priceFor(c.prices, c.finish);
    if (p == null) missing += c.copies;
    else {
      total += p * c.copies;
      priced += c.copies;
    }
  }
  return { total, priced, missing };
}
