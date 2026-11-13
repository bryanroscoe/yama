import { fmtDate } from "@yama/core";
import { boughtInfo, type MarkPair, type Order, type Swap } from "@yama/core/plan";
import type { SourceCard, SourceUse } from "./sourcing-model";

/** Copies of one card the list no longer asks for, and the order or mark that covers them. */
export interface CoveredCopies { card: string; qty: number; decks: string[]; by: string }
export interface WithoutOrdered {
  /** The list's cards without the copies already ordered: a card may be left with no use. */
  cards: SourceCard[];
  covered: CoveredCopies[];
  /** Copies left out in all. */
  copies: number;
}

const nameKey = (name: string) => name.split(" // ")[0]!.trim().replace(/[’‘]/g, "'").replace(/\s+/g, " ").toLowerCase();
/** The calendar day of a date, or of a moment as the reader's own calendar has it (an order's date is a day, not a moment). */
function day(text: unknown): string | null {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  if (!/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(text)) return text.slice(0, 10);
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** What a saved list says about the orders its wanted copies already take into account. */
export interface ListOrders {
  /** When the list was made. Without `orders_counted`, an order dated after that day is newer than the list. */
  generated_at?: string;
  /** The keys of every order the list's wanted copies already take into account. */
  orders_counted?: unknown;
}

/**
 * The saved list without the copies ordered since it was made. A saved list is a snapshot: it
 * doesn't change when an order is placed, so without this a card already on its way would be
 * offered again. A copy is covered by a real order that is placed or received and that the list
 * doesn't already count, or by a "bought it" mark made since the list. Each covered copy takes
 * one use off its card: the order line's own deck first, then the list's order (which puts the
 * copies a deck needs before optional ones). An order line for more copies than the list wants,
 * or for something the list doesn't want, changes nothing.
 */
export function withoutOrdered(cards: SourceCard[], list: ListOrders, orders: Order[], swaps: Swap[] = [], marks: Map<string, MarkPair> = new Map()): WithoutOrdered {
  const counted = Array.isArray(list.orders_counted) ? new Set(list.orders_counted.filter((k): k is string => typeof k === "string")) : null;
  const made = day(list.generated_at);
  const newer = (date: string | null) => !!made && !!day(date) && day(date)! > made;
  const fresh = orders
    .filter(o => o.kind === "real" && (o.status === "placed" || o.status === "received") && (counted ? !counted.has(o.key) : newer(o.date_ordered)))
    .sort((a, b) => (a.date_ordered ?? "").localeCompare(b.date_ordered ?? "") || a.key.localeCompare(b.key));

  const left = new Map(cards.map(c => [nameKey(c.name), { card: c, uses: [...c.uses] }]));
  const covered: CoveredCopies[] = [];
  const take = (name: string, qty: number, deck: string | null, by: string) => {
    const row = left.get(nameKey(name));
    if (!row || !(qty >= 1)) return;
    const taken: SourceUse[] = [];
    for (let n = Math.floor(qty); n > 0 && row.uses.length; n--) {
      const mine = deck ? row.uses.findIndex(u => u.deck === deck) : -1;
      taken.push(...row.uses.splice(mine >= 0 ? mine : 0, 1));
    }
    if (taken.length) covered.push({ card: row.card.name, qty: taken.length, decks: [...new Set(taken.map(u => u.deck_name))], by });
  };

  const inOrders = new Set<string>();
  for (const o of fresh) {
    const by = `${o.vendor} order${o.order_number ? ` ${o.order_number}` : ""}${day(o.date_ordered) ? ` of ${fmtDate(day(o.date_ordered))}` : ""}`;
    for (const item of o.items) {
      inOrders.add(nameKey(item.card));
      take(item.card, item.qty, item.deck, by);
    }
  }
  // A mark is the owner's own word that a copy is bought, before any order is recorded. One for
  // a card a newer order lists is taken to be that same purchase.
  for (const s of swaps) {
    const mark = marks.get(s.key)?.bought, info = boughtInfo(mark);
    if (s.retired || !mark || !info || s.order_item || inOrders.has(nameKey(s.in))) continue;
    const on = day(info.on) ?? day(mark.at);
    if (!newer(on)) continue;
    take(s.in, info.qty, s.deck, `Marked bought${info.store_label ? ` at ${info.store_label}` : ""}${on ? ` on ${fmtDate(on)}` : ""}`);
  }
  if (!covered.length) return { cards, covered, copies: 0 };
  return { cards: cards.map(c => ({ ...c, uses: left.get(nameKey(c.name))?.card === c ? left.get(nameKey(c.name))!.uses : c.uses })), covered, copies: covered.reduce((n, c) => n + c.qty, 0) };
}

/** The covered copies as one line for each order or mark: its cards by name, with a count above one. */
export function coveredLines(covered: CoveredCopies[]): { by: string; cards: string }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const c of covered) {
    // An order may list a card on two lines (two printings): one name, the copies of both.
    const cards = groups.get(c.by) ?? new Map<string, number>();
    cards.set(c.card, (cards.get(c.card) ?? 0) + c.qty);
    groups.set(c.by, cards);
  }
  return [...groups].map(([by, cards]) => ({ by, cards: [...cards].sort(([a], [b]) => a.localeCompare(b)).map(([card, qty]) => qty > 1 ? `${card} (${qty})` : card).join(", ") }));
}
