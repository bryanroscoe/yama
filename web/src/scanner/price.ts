// The prices the scanner shows for what it filed (Bryan, 15 Nov 2026: "Recent" should say what each
// card is worth), and which card counts as worth a second look. A printing's market price is the
// one for its finish, dated. A missing price stays missing: never $0, never "worth it", and left
// out of a total, which says how many were (AGENTS.md: a missing price stays missing).

import { shortDate, usd } from "@yama/core";
import type { Printing } from "../api";

/** One printing's market prices by finish, and their date. */
export interface Prices {
  usd: number | null;
  usd_foil: number | null;
  usd_etched: number | null;
  date: string | null;
}

export type ScanFinish = "nonfoil" | "foil" | "etched" | "proxy";

export const pricesOf = (p: Pick<Printing, "usd" | "usd_foil" | "usd_etched" | "price_date">): Prices => ({ usd: p.usd, usd_foil: p.usd_foil, usd_etched: p.usd_etched, date: p.price_date });

/** The market price of one copy in this finish; null when there's none (or a proxy, which has no market price). */
export function priceFor(prices: Prices | null | undefined, finish: ScanFinish): number | null {
  if (!prices || finish === "proxy") return null;
  const v = finish === "foil" ? prices.usd_foil : finish === "etched" ? prices.usd_etched : prices.usd;
  return v != null && Number.isFinite(v) ? v : null;
}

/** Worth the louder sound: a known price at or over the threshold. A missing price never is. */
export const worthIt = (price: number | null, threshold: number) => price != null && Number.isFinite(threshold) && price >= threshold;

/** A card the scanner filed this session, as the Recent list shows it. */
export interface RecentCard {
  /** Stable key (the host's entry). */
  key: string;
  name: string;
  set?: string;
  number?: string;
  finish: ScanFinish;
  copies: number;
  prices?: Prices | null;
}

const FINISH_WORD: Record<ScanFinish, string> = { nonfoil: "Regular", foil: "Foil", etched: "Etched", proxy: "Proxy" };

/**
 * "Westvale Abbey, SOI 281, Foil, $3.20": name, set and number, finish and price, with commas (no
 * middle dots). Two copies: "$3.20 each, 2 copies". A missing price: "price unknown". A proxy has
 * no price to give.
 */
export function cardLine(c: RecentCard): string {
  const parts = [c.name];
  if (c.set) parts.push(`${c.set.toUpperCase()}${c.number ? ` ${c.number}` : ""}`);
  parts.push(FINISH_WORD[c.finish]);
  if (c.finish !== "proxy") {
    const p = priceFor(c.prices, c.finish);
    parts.push(p == null ? "price unknown" : c.copies > 1 ? `${usd(p)} each` : usd(p));
  }
  if (c.copies > 1) parts.push(`${c.copies} copies`);
  return parts.join(", ");
}

/** "market, Nov 14": where the price comes from, when it has one. */
export function priceDateLine(c: RecentCard): string | null {
  if (priceFor(c.prices, c.finish) == null) return null;
  const d = shortDate(c.prices?.date ?? null);
  return d ? `market price, ${d}` : "market price, date unknown";
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

/** "Total $41.20 for 12 cards, 2 without a price left out". */
export function totalLine(t: ReturnType<typeof sessionTotal>): string | null {
  if (t.priced === 0 && t.missing === 0) return null;
  const base = `Total ${usd(t.total)} for ${t.priced} ${t.priced === 1 ? "card" : "cards"}`;
  return t.missing ? `${base}, ${t.missing} without a price left out` : base;
}
