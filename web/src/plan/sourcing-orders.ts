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
/** A time with its zone, in milliseconds; null for a day alone or text that isn't a time. */
function moment(text: unknown): number | null {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
}
/** The calendar day of a date, or of a moment as the reader's own calendar has it (an order's date is a day, not a moment). */
function day(text: unknown): string | null {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const ms = moment(text);
  if (ms == null) return text.slice(0, 10);
  const at = new Date(ms);
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
 * doesn't already count, or by a "bought it" mark made after the list. Each covered copy takes
 * one use off its card, wherever in the list that card's rows are: the order line's or mark's own
 * deck first, then the list's order (which puts the copies a deck needs before optional ones).
 * An order line for more copies than the list wants, or for something it doesn't want, changes
 * nothing.
 *
 * A mark and an order may be the same purchase. A mark is one with an order line's copy for the
 * same card and deck, and an order line that names no deck is one with a mark for its card:
 * each copy counts once. A mark for another deck than the order line's is another copy.
 *
 * An order has a day, not a time: one placed the day the list was made is taken as known to the
 * list. A mark has a time, and is compared with the list's own.
 */
export function withoutOrdered(cards: SourceCard[], list: ListOrders, orders: Order[], swaps: Swap[] = [], marks: Map<string, MarkPair> = new Map()): WithoutOrdered {
  const counted = Array.isArray(list.orders_counted) ? new Set(list.orders_counted.filter((k): k is string => typeof k === "string")) : null;
  const made = day(list.generated_at), madeAt = moment(list.generated_at);
  const laterDay = (date: unknown) => !!made && !!day(date) && day(date)! > made;
  const fresh = orders
    .filter(o => o.kind === "real" && (o.status === "placed" || o.status === "received") && (counted ? !counted.has(o.key) : laterDay(o.date_ordered)))
    .sort((a, b) => (a.date_ordered ?? "").localeCompare(b.date_ordered ?? "") || a.key.localeCompare(b.key));
  const label = (o: Order) => `${o.vendor} order${o.order_number ? ` ${o.order_number}` : ""}${day(o.date_ordered) ? ` of ${fmtDate(day(o.date_ordered))}` : ""}`;

  // Every use of a card, across however many rows the list gives it, in the list's order.
  const left = new Map<string, { name: string; uses: SourceUse[] }>();
  for (const c of cards) {
    const row = left.get(nameKey(c.name)) ?? { name: c.name, uses: [] };
    row.uses.push(...c.uses);
    left.set(nameKey(c.name), row);
  }
  const gone = new Set<SourceUse>(), covered: CoveredCopies[] = [];
  const take = (name: string, qty: number, deck: string | null, by: string): SourceUse[] => {
    const row = left.get(nameKey(name)), taken: SourceUse[] = [];
    if (!row || !(qty >= 1)) return taken;
    for (let n = Math.floor(qty); n > 0 && row.uses.length; n--) {
      const mine = deck ? row.uses.findIndex(u => u.deck === deck) : -1;
      taken.push(...row.uses.splice(mine >= 0 ? mine : 0, 1));
    }
    for (const u of taken) gone.add(u);
    if (taken.length) covered.push({ card: row.name, qty: taken.length, decks: [...new Set(taken.map(u => u.deck_name))], by });
    return taken;
  };
  const counts = new Map<string, number>();
  const add = (key: string, n: number) => counts.set(key, (counts.get(key) ?? 0) + n);
  /** Up to `want` of the copies counted under `key`, which are then spent. */
  const spend = (key: string, want: number) => { const n = Math.min(want, counts.get(key) ?? 0); add(key, -n); return n; };

  // Order lines that say which deck the copy is for.
  for (const o of fresh) for (const item of o.items) {
    if (item.deck) for (const u of take(item.card, item.qty, item.deck, label(o))) add(`order\n${nameKey(item.card)}\n${u.deck}`, 1);
  }
  // A mark is the owner's own word that a copy is bought, before any order is recorded.
  for (const s of swaps) {
    const mark = marks.get(s.key)?.bought, info = boughtInfo(mark);
    if (s.retired || !mark || !info || s.order_item) continue;
    const markAt = moment(mark.at);
    if (!(madeAt != null && markAt != null ? markAt > madeAt : laterDay(mark.at))) continue;
    const on = day(info.on) ?? day(mark.at);
    const more = info.qty - spend(`order\n${nameKey(s.in)}\n${s.deck}`, info.qty);
    add(`mark\n${nameKey(s.in)}`, take(s.in, more, s.deck, `Marked bought${info.store_label ? ` at ${info.store_label}` : ""}${on ? ` on ${fmtDate(on)}` : ""}`).length);
  }
  // Order lines that name no deck.
  for (const o of fresh) for (const item of o.items) {
    const qty = Number.isFinite(item.qty) ? Math.max(0, Math.floor(item.qty)) : 0;
    if (!item.deck) take(item.card, qty - spend(`mark\n${nameKey(item.card)}`, qty), null, label(o));
  }
  if (!covered.length) return { cards, covered, copies: 0 };
  return { cards: cards.map(c => c.uses.some(u => gone.has(u)) ? { ...c, uses: c.uses.filter(u => !gone.has(u)) } : c), covered, copies: covered.reduce((n, c) => n + c.qty, 0) };
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
