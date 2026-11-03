import type { SellCard } from "./sellList";
import { special } from "./sellList";

export interface BuylistOffer {
  checked_at: string;
  source: string;
  store: string;
  status: "accepting" | "not_accepting" | "unmatched" | "check_printing" | "ambiguous" | "unknown";
  cash_usd: number | null;
  credit_usd: number | null;
  quantity_limit: number | null;
  product_id: string | null;
  variant_id: string | null;
  title: string | null;
  note: string;
}

export function offerKey(c: SellCard): string {
  return JSON.stringify([c.scryfall_id, c.finish, c.condition]);
}
export function canCheck(c: SellCard): boolean {
  return !c.proxy && c.lang === "en" && special(c).length === 0 && !!c.name;
}

export function currentOffer(o: BuylistOffer, now = Date.now()): boolean {
  const checked = Date.parse(o.checked_at);
  return Number.isFinite(checked) && checked > now - 6 * 60 * 60 * 1000 && checked <= now + 5 * 60 * 1000;
}

/** Allocate the store's limit once across containers, including distinct rows for one printing. */
export function offerTotals(cards: SellCard[], offers: Map<string, BuylistOffer>, qty: (c: SellCard) => number, now = Date.now()) {
  const used = new Map<string, number>();
  const quantities = new Map<string, number>();
  let cash = 0, credit = 0, copies = 0, creditUnknown = 0, unchecked = 0;
  for (const c of cards) {
    const n = Math.min(c.qty, Math.max(0, qty(c)));
    if (!n || !canCheck(c)) continue;
    const o = offers.get(offerKey(c));
    if (!o || !currentOffer(o, now)) { unchecked += n; continue; }
    if (o.status !== "accepting" || o.cash_usd == null || o.quantity_limit == null || !o.product_id || !o.variant_id) continue;
    const key = JSON.stringify([o.product_id, o.variant_id]);
    const available = Math.max(0, o.quantity_limit - (used.get(key) ?? 0));
    const count = Math.min(n, available);
    used.set(key, (used.get(key) ?? 0) + count);
    cash += count * o.cash_usd;
    if (o.credit_usd == null) creditUnknown += count;
    else credit += count * o.credit_usd;
    copies += count;
    if (count > 0) quantities.set(c.id, count);
  }
  return { cash, credit, copies, creditUnknown, unchecked, quantities };
}
