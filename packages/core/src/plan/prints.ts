// The print plan (docs/planner-design.md section 7, `printPlan`): what is on each print (proxy)
// order, and what the next order would hold. A print's line says what it takes out when it goes
// in: the plan's cut, or the stand-in that holds the slot until then. Proxy cost comes from the
// owner's settings and is kept apart from market prices.

import { rulesAt, type RuleSet } from "./rules";
import type { Order, PlanBundle, PlanCard, PlanDeck, Review, Store, Swap } from "./types";

export interface PrintLine {
  swap: Swap;
  card: string;
  deck: PlanDeck | undefined;
  /** The plan's cut for this slot. */
  cut: string | null;
  /** The stand-in holding the slot until the print arrives; it is what leaves the deck then. */
  standin: Swap | null;
  /** What comes out of the deck when the print goes in. */
  takesOut: string | null;
  /** Double-faced: the back face to print, or null. */
  back: string | null;
  /** A proposal you said you want (next order only). */
  proposed: boolean;
}

export interface OrderLine {
  card: string;
  qty: number;
}

export interface PrintOrder {
  order: Order;
  /** The plan's prints that name this order, A to Z. */
  lines: PrintLine[];
  /** Cards on the order's own list that no plan print accounts for. */
  extra: OrderLine[];
  /** Plan prints naming this order that its own list doesn't have. */
  missing: PrintLine[];
  count: number;
  distinct: number;
}

export interface Tier {
  /** The smallest recorded tier that fits, or null when the order is larger than all of them. */
  size: number | null;
  free: number | null;
  tiers: number[];
}

export interface NextOrder {
  lines: PrintLine[];
  count: number;
  tier: Tier;
  /** Per card, from your settings ("at least $0.30"); null when not set. */
  each: number | null;
  eachNote: string | null;
  /** count × each; null when there's no proxy cost setting. */
  estimate: number | null;
}

export interface PrintPlan {
  printer: Store | null;
  /** Placed and not arrived. */
  placed: PrintOrder[];
  received: PrintOrder[];
  next: NextOrder;
  /** Every print with a double-faced card, across orders. */
  doubleFaced: PrintLine[];
}

export type PrintData = Pick<PlanBundle, "decks" | "swaps" | "orders" | "stores" | "settings" | "cards" | "names">;

const DFC = new Set(["transform", "modal_dfc", "reversible_card", "double_faced_token"]);

/** The back face to print for a double-faced card, or null for a one-faced card. */
export function backFace(card: PlanCard | undefined): string | null {
  if (!card || !card.layout || !DFC.has(card.layout) || !Array.isArray(card.faces)) return null;
  const back = card.faces[1] as { name?: unknown } | undefined;
  return typeof back?.name === "string" ? back.name : null;
}

/** The smallest recorded tier that holds `n` cards, and its free slots. */
export function pickTier(n: number, tiers: number[] | null | undefined): Tier {
  const list = [...(tiers ?? [])].filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  const size = list.find((t) => t >= n) ?? null;
  return { size, free: size == null ? null : size - n, tiers: list };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byCard = (a: PrintLine, b: PrintLine) => cmp(a.card.toLowerCase(), b.card.toLowerCase()) || cmp(a.deck?.name ?? "", b.deck?.name ?? "");

/** "N Name" lines, A to Z by lower-cased name, the format the printer's order page takes. */
export function orderText(lines: OrderLine[]): string {
  const n = new Map<string, number>();
  for (const l of lines) n.set(l.card, (n.get(l.card) ?? 0) + l.qty);
  const sorted = [...n].sort(([a], [b]) => cmp(a.toLowerCase(), b.toLowerCase()));
  return sorted.map(([c, q]) => `${q} ${c}`).join("\n") + (sorted.length ? "\n" : "");
}


export interface PrintPlanOptions {
  answers: Map<string, Review>;
  /** YYYY-MM-DD, for the proxy cost rule in force. */
  today: string;
}

/**
 * Planned prints by the order they're on. A print on no order, or on a draft order, goes to the
 * next order, together with proposed prints you said you want. Tiers come from the printer store.
 */
export function printPlan(b: PrintData, opts: PrintPlanOptions): PrintPlan {
  const decks = new Map(b.decks.map((d) => [d.key, d]));
  const live = b.swaps.filter((s) => !s.retired && decks.get(s.deck)?.status !== "archived");
  const standinOf = new Map<string, Swap>();
  for (const s of live) if (s.role === "standin" && s.stage === "planned" && s.parent) standinOf.set(s.parent, s);
  const card = (name: string) => {
    const id = b.names[name.trim()];
    return id ? b.cards[id] : undefined;
  };
  const line = (s: Swap, proposed = false): PrintLine => {
    const standin = standinOf.get(s.key) ?? null;
    const cut = proposed ? opts.answers.get(s.key)?.cut || s.out : s.out;
    return { swap: s, card: s.in, deck: decks.get(s.deck), cut, standin, takesOut: standin ? standin.in : cut, back: backFace(card(s.in)), proposed };
  };

  const proxies = b.orders.filter((o) => o.kind === "proxy" && !o.retired && o.status !== "cancelled");
  const onOrder = new Map<string, PrintLine[]>();
  const next: PrintLine[] = [];
  const prints = live.filter((s) => s.src === "print" && s.stage === "planned" && s.role === "swap");
  for (const s of prints) {
    const o = s.print_order ? proxies.find((p) => p.key === s.print_order) : undefined;
    if (o && o.status !== "draft") onOrder.set(o.key, [...(onOrder.get(o.key) ?? []), line(s)]);
    else next.push(line(s));
  }
  for (const s of live) {
    if (s.stage === "proposed" && s.src === "print" && opts.answers.get(s.key)?.decision === "want") next.push(line(s, true));
  }

  const toOrder = (o: Order): PrintOrder => {
    const lines = (onOrder.get(o.key) ?? []).sort(byCard);
    const listed = new Map<string, number>();
    for (const it of o.items) listed.set(it.card, (listed.get(it.card) ?? 0) + it.qty);
    const missing: PrintLine[] = [];
    if (o.items.length) {
      const left = new Map(listed);
      for (const l of lines) {
        const n = left.get(l.card) ?? 0;
        if (n > 0) left.set(l.card, n - 1);
        else missing.push(l);
      }
      listed.clear();
      for (const [c, n] of left) if (n > 0) listed.set(c, n);
    } else listed.clear();
    return {
      order: o,
      lines,
      extra: [...listed].map(([card, qty]) => ({ card, qty })).sort((x, y) => cmp(x.card.toLowerCase(), y.card.toLowerCase())),
      missing,
      count: lines.length,
      distinct: new Set(lines.map((l) => l.card)).size,
    };
  };
  const ordered = proxies.filter((o) => o.status !== "draft").map(toOrder);
  const printer =
    b.stores.find((s) => s.kind === "printer" && !s.retired && proxies.some((o) => o.store === s.key)) ??
    b.stores.find((s) => s.kind === "printer" && !s.retired) ??
    null;
  const rules = rulesAt(b.settings as unknown as RuleSet[], opts.today)?.rules ?? {};
  next.sort(byCard);
  const each = rules.proxy_cost_usd ?? null;
  const all = [...ordered.flatMap((o) => o.lines), ...next];
  return {
    printer,
    placed: ordered.filter((o) => o.order.status === "placed"),
    received: ordered.filter((o) => o.order.status === "received"),
    next: {
      lines: next,
      count: next.length,
      tier: pickTier(next.length, printer?.print_tiers),
      each,
      eachNote: rules.proxy_cost_note ?? null,
      estimate: each == null ? null : Math.round(each * next.length * 100) / 100,
    },
    doubleFaced: all.filter((l) => l.back),
  };
}
