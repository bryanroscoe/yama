// "Where it came from" sentences, built from structured fields (got, order_item, print_order) rather
// than the writer's own text, so a shared page can leave out stores, dates and prices.
// gotText is a port of commander-decks' swapdata.got_text.

import { BASICS } from "./text";
import type { Bag, Got, ItemRef, Order, OrderItem, PlanBundle, PlanDeck, Slot, Store, Swap } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-08" → "8 Oct 2026". Anything else is returned as given; a missing date is "". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  // A moment (a time with its zone: "2026-11-05T04:30:00Z") is shown on the reader's own
  // calendar: saved at 22:30 in Texas reads 4 Nov, not UTC's 5 Nov. A date alone stays as written.
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime())) return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
  }
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}

/** Dollars with cents, or "no price". Never $0 for a missing price. */
export function usd(v: number | null | undefined): string {
  return v == null ? "no price" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface SourceContext {
  orders: Map<string, Order>;
  stores: Map<string, Store>;
  decks: Map<string, PlanDeck>;
}

export interface SourceOptions {
  /**
   * Owner pages (the default) say which store, when and for how much. With `false`, sentences
   * leave out stores, order dates and prices paid, for a shared view.
   */
  private?: boolean;
}

export function sourceContext(b: Pick<PlanBundle, "orders" | "stores" | "decks">): SourceContext {
  return {
    orders: new Map(b.orders.map((o) => [o.key, o])),
    stores: new Map(b.stores.map((s) => [s.key, s])),
    decks: new Map(b.decks.map((d) => [d.key, d])),
  };
}

function storeName(o: Order, ctx: SourceContext): string {
  const s = o.store ? ctx.stores.get(o.store) : undefined;
  return s?.short ?? s?.name ?? o.vendor;
}

function orderDate(o: Order): string {
  if (o.date_ordered) return `ordered ${fmtDate(o.date_ordered)}`;
  if (o.placed_by) return `placed by ${fmtDate(o.placed_by)}`;
  return "order date not recorded";
}

function itemOf(o: Order | undefined, ref: ItemRef | null | undefined): OrderItem | undefined {
  return ref ? o?.items.find((i) => i.line === ref.line) : undefined;
}

/** "bought at Pat's, ordered 8 Oct 2026" (lower case, to go inside a sentence). */
function boughtPhrase(orderKey: string, ctx: SourceContext, opts: SourceOptions): string {
  const o = ctx.orders.get(orderKey);
  if (opts.private === false || !o) return "bought";
  return `bought at ${storeName(o, ctx)}, ${orderDate(o)}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function deckName(key: string | null | undefined, fallback: string | null | undefined, ctx: SourceContext): string {
  return fallback ?? (key ? ctx.decks.get(key)?.name ?? key : null) ?? "another deck";
}

/** Where an owned card came from, as one sentence. */
export function gotText(got: Got, ctx: SourceContext, opts: SourceOptions = {}): string {
  if (got.how === "bought") return `${cap(boughtPhrase(got.order, ctx, opts))}.`;
  if (got.how === "pulled") {
    const date = got.date && opts.private !== false ? ` (${fmtDate(got.date)})` : "";
    return `Pulled from ${got.product}${date}.`;
  }
  const name = deckName(got.deck, got.deck_name, ctx);
  if (got.origin === "precon") return `From ${name} (came in that precon).`;
  return `From ${name} (${boughtPhrase(got.origin, ctx, opts)} for that deck).`;
}

/** "Bought at Pat's, ordered 8 Oct 2026, $0.50": the order, its date and the price paid. */
export function boughtText(ref: ItemRef, ctx: SourceContext, opts: SourceOptions = {}): string {
  const o = ctx.orders.get(ref.order);
  const base = cap(boughtPhrase(ref.order, ctx, opts));
  if (opts.private === false || !o) return `${base}.`;
  const item = itemOf(o, ref);
  return `${base}, ${item?.unit_price == null ? "price not recorded" : usd(item.unit_price)}.`;
}

/** "Print, on the MakePlayingCards order placed by 15 Oct 2026" or "Print, for the next print order". */
export function printText(orderKey: string | null | undefined, ctx: SourceContext, opts: SourceOptions = {}): string {
  const o = orderKey ? ctx.orders.get(orderKey) : undefined;
  if (!o) return "Print, for the next print order.";
  if (opts.private === false) return o.status === "received" ? "Print, arrived." : "Print, on order.";
  const printer = (o.store ? ctx.stores.get(o.store)?.name : undefined) ?? o.vendor;
  if (o.status === "received") return `Print, arrived from ${printer}${o.date_fulfilled ? ` ${fmtDate(o.date_fulfilled)}` : ""}.`;
  const when = o.date_ordered ? `placed ${fmtDate(o.date_ordered)}` : o.placed_by ? `placed by ${fmtDate(o.placed_by)}` : "placed, date not recorded";
  return `Print, on the ${printer} order ${when}.`;
}

/** Where a swap's card comes from. */
export function swapSource(s: Swap, ctx: SourceContext, opts: SourceOptions = {}): string {
  if (s.src === "owned") return s.got ? gotText(s.got, ctx, opts) : "A card you own.";
  if (s.src === "print") {
    if (s.stage === "proposed") return "To print.";
    return printText(s.print_order, ctx, opts);
  }
  if (s.order_item) return boughtText(s.order_item, ctx, opts);
  if (s.stage === "proposed") return "To buy.";
  return opts.private !== false && s.store_label ? `Not bought yet (planned at ${s.store_label}).` : "Not bought yet.";
}

/**
 * Where a bracket swap-back's card comes from. Owner pages keep the writer's sentence (`from`).
 * A shared view never uses it, because it can name a store and an order date: it builds the
 * sentence from `got`, or says what it can without one.
 */
export function bagSource(bag: Pick<Bag, "in" | "from" | "got">, ctx: SourceContext, deck?: PlanDeck, opts: SourceOptions = {}): string {
  if (opts.private !== false && bag.from) return `${bag.from.replace(/\.$/, "")}.`;
  const g = bag.got;
  if (g) {
    const own = g.how === "deck" && g.origin === "precon" && !!deck && (g.deck === deck.key || (!g.deck && g.deck_name === deck.name));
    return own ? "Came in this precon." : gotText(g, ctx, opts);
  }
  return BASICS.has(bag.in) ? "Basic land." : "A card you own.";
}

/** Where a card in a list comes from. Falls back to the writer's own sentence on owner pages. */
export function slotSource(slot: Slot, ctx: SourceContext, deck?: PlanDeck, opts: SourceOptions = {}): string {
  switch (slot.kind) {
    case "stock":
      return slot.board === "commander" ? "Your commander." : "Came in the precon.";
    case "owner": {
      const change = deck?.owner_changes.find((c) => c.in === slot.name);
      return opts.private !== false && change?.note ? `${change.note.replace(/\.$/, "")}.` : "Your own change before the plans.";
    }
    case "fill":
      return "Basic land for now, until the print arrives.";
    case "print":
      return printText(slot.print_order, ctx, opts);
    case "moved":
      if (slot.got) return gotText(slot.got, ctx, opts);
      if (slot.from_deck) return `From ${deckName(slot.from_deck, null, ctx)}.`;
      break;
    case "bought":
    case "standin":
    case "optional":
      if (slot.order_item) return boughtText(slot.order_item, ctx, opts);
      if (slot.got) return gotText(slot.got, ctx, opts);
      break;
    case "bracket":
      return bagSource({ in: slot.name, from: slot.source, got: slot.got }, ctx, deck, opts);
    case "proposed":
      // Built on the device from a proposed swap. It has no structured source, so a shared view
      // says nothing rather than pass the writer's text through.
      break;
  }
  return opts.private !== false ? slot.source ?? "" : "";
}
