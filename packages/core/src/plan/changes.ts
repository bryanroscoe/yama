// A deck's swaps grouped for its Changes tab, each swap's status from the stored lists' logs, and
// the counts the overview shows. Read-only: nothing here changes a list.

import type { LogStatus, Order, PlanDeck, PlanGroup, Review, Swap } from "./types";

export type ChangeSort = "plan" | "in" | "in-desc" | "out" | "tier";

/** Filter a displayed group without losing a print's attached stand-ins or changing plan order. */
export function selectChangeSwaps(swaps: Swap[], query: string, sort: ChangeSort, standins: Map<string, Swap[]> = new Map()): Swap[] {
  const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const result = swaps.filter((s) => {
    const text = normalize([s, ...(standins.get(s.key) ?? [])].flatMap((r) => [r.in, r.out, r.plan_card, r.later_out, r.why, r.why_out, r.note, r.advice, r.when, r.tier, r.group, r.store_label]).filter(Boolean).join(" "));
    return terms.every((term) => text.includes(term));
  });
  const compare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  return result.sort((a, b) => {
    switch (sort) {
      case "in": return compare(a.in, b.in) || a.sort - b.sort;
      case "in-desc": return compare(b.in, a.in) || a.sort - b.sort;
      case "out": return Number(!a.out) - Number(!b.out) || compare(a.out ?? "", b.out ?? "") || a.sort - b.sort;
      case "tier": return Number(!a.tier) - Number(!b.tier) || compare(a.tier ?? "", b.tier ?? "") || a.sort - b.sort;
      default: return a.sort - b.sort;
    }
  });
}

export type Tone = "good" | "warn" | "plain";

export interface Status {
  label: string;
  tone: Tone;
}

function logOf(deck: PlanDeck, state: "now" | "after"): Map<string, LogStatus> {
  const m = new Map<string, LogStatus>();
  for (const e of deck.states[state]?.log ?? []) if (e.swap) m.set(e.swap, e.status);
  return m;
}

export interface DeckLogs {
  now: Map<string, LogStatus>;
  after: Map<string, LogStatus>;
  /** Names in the now list, so a stand-in can say whether it's in the deck. */
  nowNames: Set<string>;
}

export function deckLogs(deck: PlanDeck): DeckLogs {
  return { now: logOf(deck, "now"), after: logOf(deck, "after"), nowNames: new Set((deck.states.now?.cards ?? []).map((c) => c.name)) };
}

/** Where a planned swap stands, in words, from the stored logs. Proposals have none. */
export function swapStatus(s: Swap, logs: DeckLogs, deckName: (key: string | null | undefined) => string, orders?: Map<string, Order>): Status | null {
  if (s.stage !== "planned") return null;
  if (s.role === "standin") {
    return logs.nowNames.has(s.in) ? { label: "In the deck until the print arrives", tone: "good" } : { label: "Not in the now list", tone: "plain" };
  }
  const now = logs.now.get(s.key);
  const orderStatus = s.print_order ? (orders ? orders.get(s.print_order)?.status ?? "draft" : "placed") : null;
  if (s.src === "print" && orderStatus === "received") return { label: "Print arrived", tone: "good" };
  const onOrder = orderStatus === "placed";
  const print = onOrder ? "print on order" : "print with the next order";
  switch (now) {
    case "done":
      return { label: "In hand", tone: "good" };
    case "moved":
      return { label: "Moved in", tone: "good" };
    case "standin":
      return { label: `Stand-in now, ${print}`, tone: "warn" };
    case "fill":
      return { label: `Basic land for now, ${print}`, tone: "warn" };
    case "waiting":
      if (s.src === "print") return { label: onOrder ? "Print on order" : "Print, next order", tone: "warn" };
      if (s.src === "buy") return { label: "Not bought yet", tone: "warn" };
      return { label: "Waiting", tone: "warn" };
    case "waiting-move": {
      const from = s.got?.how === "deck" ? s.got.deck_name ?? deckName(s.got.deck) : "the other deck";
      return { label: s.after_print ? `Waiting for ${from} to free it when its print arrives` : `Waiting for ${from} to free it`, tone: "warn" };
    }
    case "spare":
      return { label: "Spare, not in the list", tone: "plain" };
  }
  switch (logs.after.get(s.key)) {
    case "print":
      return { label: onOrder ? "Print on order" : "Print, next order", tone: "warn" };
    case "moved":
      return { label: "Moves in when prints arrive", tone: "warn" };
    case "done":
      return { label: "In hand", tone: "good" };
    case "spare":
      return { label: "Spare, not in the list", tone: "plain" };
  }
  return null;
}

export interface ProposalGroup {
  /** `null` for proposals in no listed group. */
  group: PlanGroup | null;
  swaps: Swap[];
}

export interface Changes {
  /** Planned swaps that apply now: buys, moves. */
  now: Swap[];
  /** Planned prints, and moves that wait for one. */
  prints: Swap[];
  optional: Swap[];
  /** Stand-ins by the key of the print swap they hold. */
  standins: Map<string, Swap[]>;
  /** Stand-ins whose print swap isn't in this deck's live swaps. */
  loose: Swap[];
  proposed: ProposalGroup[];
}

/** One deck's live swaps, grouped as the Changes tab shows them, each group in plan order. */
export function deckChanges(deckKey: string, groups: PlanGroup[], swaps: Swap[]): Changes {
  const mine = swaps.filter((s) => s.deck === deckKey && !s.retired).sort((a, b) => a.sort - b.sort);
  const planned = mine.filter((s) => s.stage === "planned");
  const keys = new Set(planned.map((s) => s.key));
  const standins = new Map<string, Swap[]>();
  const loose: Swap[] = [];
  for (const s of planned.filter((s) => s.role === "standin")) {
    if (s.parent && keys.has(s.parent)) standins.set(s.parent, [...(standins.get(s.parent) ?? []), s]);
    else loose.push(s);
  }
  const swapsOnly = planned.filter((s) => s.role === "swap");
  const proposals = mine.filter((s) => s.stage === "proposed");
  const labels = new Set(groups.map((g) => g.label));
  const proposed: ProposalGroup[] = groups
    .map((g) => ({ group: g, swaps: proposals.filter((s) => s.group === g.label) }))
    .filter((g) => g.swaps.length > 0);
  const ungrouped = proposals.filter((s) => !s.group || !labels.has(s.group));
  if (ungrouped.length) proposed.unshift({ group: null, swaps: ungrouped });
  return {
    now: swapsOnly.filter((s) => s.src !== "print" && !s.after_print),
    prints: swapsOnly.filter((s) => s.src === "print" || s.after_print),
    optional: planned.filter((s) => s.role === "optional"),
    standins,
    loose,
    proposed,
  };
}

export interface DeckCounts {
  /** Planned swaps (not stand-ins or optional extras). */
  planned: number;
  /** Planned swaps whose card is in the now list: in hand, or moved in. */
  ready: number;
  standins: number;
  printsOnOrder: number;
  printsNext: number;
  /** Moves waiting for another deck to free the card. */
  waitingMoves: number;
  proposals: number;
  /** Proposals with no answer yet. */
  undecided: number;
}

/**
 * A deck's counts. With `orders` (by key), a print counts as on order only while its order is
 * placed: one on a received order has arrived, and one on a draft order is for the next order.
 * Without them, any print naming an order counts as on order.
 */
export function deckCounts(deck: PlanDeck, swaps: Swap[], answers: Map<string, Review>, orders?: Map<string, Order>): DeckCounts {
  const logs = deckLogs(deck);
  const mine = swaps.filter((s) => s.deck === deck.key && !s.retired);
  const planned = mine.filter((s) => s.stage === "planned" && s.role === "swap");
  const proposals = mine.filter((s) => s.stage === "proposed");
  const status = (s: Swap) => logs.now.get(s.key);
  const orderStatus = (s: Swap) => (s.print_order ? (orders ? orders.get(s.print_order)?.status ?? "draft" : "placed") : null);
  const prints = planned.filter((s) => s.src === "print");
  return {
    planned: planned.length,
    ready: planned.filter((s) => status(s) === "done" || status(s) === "moved").length,
    standins: planned.filter((s) => status(s) === "standin").length,
    printsOnOrder: prints.filter((s) => orderStatus(s) === "placed").length,
    printsNext: prints.filter((s) => orderStatus(s) == null || orderStatus(s) === "draft" || orderStatus(s) === "cancelled").length,
    waitingMoves: planned.filter((s) => status(s) === "waiting-move").length,
    proposals: proposals.length,
    undecided: proposals.filter((s) => !answers.get(s.key)?.decision).length,
  };
}

/**
 * The warnings that belong to one deck: Yama's own import warnings (they start with the deck's
 * name) and the writer's warnings naming the deck.
 */
export function deckWarnings(deck: PlanDeck, warnings: string[], exportWarnings: { deck: string | null; text: string }[]): string[] {
  return [
    ...warnings.filter((w) => w.startsWith(`${deck.name}:`) || w.startsWith(`${deck.name} (`)),
    ...exportWarnings.filter((w) => w.deck === deck.key).map((w) => w.text),
  ];
}
