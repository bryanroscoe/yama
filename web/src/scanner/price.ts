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
  /** Its write isn't confirmed yet ("saving"), or the last send failed ("failed"). */
  state?: "saving" | "failed";
}

/** The session's total market value: priced copies only, and how many cards (not proxies) had no price. */
export function sessionTotal(cards: readonly RecentCard[]): { total: number; priced: number; missing: number } {
  let total = 0;
  let priced = 0;
  let missing = 0;
  for (const c of cards) {
    if (c.finish === "proxy") continue;
    const p = priceFor(c.prices, c.finish);
    if (p == null) missing += c.copies;
    else {
      total += p * c.copies;
      priced += c.copies;
    }
  }
  return { total, priced, missing };
}
