// One plan per deck (ARCHITECTURE.md, "Plans: one plan per deck", 2026-11-06). The server says each
// deck's plan state and version (`deck.plan`, server/src/plan/versions.rs); this file turns a
// plan's changes into what the plan pages show: where each card comes from, what it costs, what's
// left to do, and the line under a plan's title.

import { fmtDate } from "./source";
import { installedState } from "./marks";
import { newestChecks } from "./quotes";
import { cheapestMarket } from "./rules";
import type { DeckPlanState, Mark, PlanCut, Order, PlanBundle, PlanDeck, PlanHead, PlanStateName, Quote, Review, Swap, VersionSource } from "./types";

export const PLAN_STATE_LABEL: Record<PlanStateName, string> = {
  waiting: "Waiting for your OK",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
  empty: "No plan yet",
};

/** The deck's plan, or one read from the deck itself for a bundle saved before plans had states. */
export function planOf(deck: PlanDeck, swaps: Swap[]): DeckPlanState {
  if (deck.plan) return deck.plan;
  const mine = swaps.filter((s) => s.deck === deck.key && !s.retired);
  const planned = mine.filter((s) => s.stage === "planned" && s.role === "swap");
  const proposals = mine.filter((s) => s.stage === "proposed").map((s) => s.key);
  const archived = deck.status === "archived";
  const state: PlanStateName = archived ? "archived" : planned.length ? "in_progress" : proposals.length ? "waiting" : "empty";
  return {
    state,
    version: planned.length ? 1 : null,
    approved_at: null,
    next: proposals.length && !archived ? { n: planned.length ? 2 : 1, keys: proposals, skipped: [], proposed_at: null, source: { kind: "yama" }, hash: "" } : null,
    changes: planned.length,
    installed: 0,
    questions: (deck.notes ?? []).filter((n) => n.kind === "open_question").map((n) => n.text),
    archived_at: null,
    archived_note: null,
  };
}

/** A plan whose changes feed Get the cards: approved, not archived. */
export function inForce(plan: DeckPlanState): boolean {
  return plan.state === "in_progress" || plan.state === "done";
}

/** Where a change's card comes from. */
export type ChangeKind = "have" | "move" | "buy" | "print";

export const KIND_ORDER: ChangeKind[] = ["have", "move", "buy", "print"];

export const KIND_TITLE: Record<ChangeKind, string> = {
  have: "You have it",
  move: "From other decks",
  buy: "To buy",
  print: "To print",
};

/**
 * A print is printed; a buy is bought; an owned card that a plan takes from another of your decks
 * (`got.how === "deck"` naming another deck) moves; any other owned card you have.
 */
export function changeKind(s: Swap): ChangeKind {
  if (s.src === "print") return "print";
  if (s.src === "buy") return "buy";
  if (s.got?.how === "deck" && s.got.deck && s.got.deck !== s.deck) return "move";
  return "have";
}

export interface ChangePrice {
  usd: number;
  date: string | null;
  /** The store's name for a store's listed price; null for Yama's market price. */
  store: string | null;
}

/**
 * What a card to buy costs: the cheapest in-stock listing among each store's newest checks for it
 * (the plan's own and the store snapshots), else Yama's cheapest market price. Null when nothing
 * has a price: unknown, never $0.
 */
export function changePrice(s: Swap, b: Pick<PlanBundle, "quotes" | "stores" | "market" | "market_by_printing" | "printing_ids" | "names" | "prices_as_of"> & { store_quotes?: Quote[] }): ChangePrice | null {
  const quotes = [...b.quotes.filter((q) => q.swap === s.key), ...(b.store_quotes ?? []).filter((q) => q.card === s.in)];
  const stores = new Map(b.stores.map((st) => [st.key, st]));
  const listed = newestChecks(quotes)
    // Dollar totals take dollar prices only; a listing in another currency isn't compared.
    .filter((q) => q.price != null && q.in_stock !== false && (q.currency ?? "USD") === "USD")
    .sort((x, y) => x.price! - y.price!);
  const best = listed[0];
  if (best) return { usd: best.price!, date: best.checked, store: (best.store ? stores.get(best.store)?.name : null) ?? best.store_label ?? null };
  const m = cheapestMarket(s.in, b);
  return m ? { usd: m.usd, date: m.date, store: null } : null;
}

export interface PlanChange {
  swap: Swap;
  kind: ChangeKind;
  /** For a move: the deck it comes from, by name. */
  from: string | null;
  /** For a buy. */
  price: ChangePrice | null;
}

export function planChange(s: Swap, b: Parameters<typeof changePrice>[1], deckName: (key: string | null | undefined) => string): PlanChange {
  const kind = changeKind(s);
  const from = kind === "move" && s.got?.how === "deck" ? (s.got.deck_name ?? deckName(s.got.deck)) : null;
  return { swap: s, kind, from, price: kind === "buy" ? changePrice(s, b) : null };
}

export interface PlanCounts {
  total: number;
  have: number;
  move: number;
  buy: number;
  print: number;
  /** The listed total of the buys with a price; null when none has one. */
  buyUsd: number | null;
  /** Buys with no price at all. */
  buyUnpriced: number;
  /** Stores the buys' prices come from, and the newest price date. */
  stores: string[];
  pricedOn: string | null;
}

export function countChanges(changes: PlanChange[]): PlanCounts {
  const n = (k: ChangeKind) => changes.filter((c) => c.kind === k).length;
  const buys = changes.filter((c) => c.kind === "buy");
  const priced = buys.filter((c) => c.price);
  const stores = [...new Set(priced.map((c) => c.price!.store ?? "market"))];
  const dates = priced.map((c) => c.price!.date).filter((d): d is string => !!d).sort();
  return {
    total: changes.length,
    have: n("have"),
    move: n("move"),
    buy: buys.length,
    print: n("print"),
    buyUsd: priced.length ? Math.round(priced.reduce((t, c) => t + c.price!.usd, 0) * 100) / 100 : null,
    buyUnpriced: buys.length - priced.length,
    stores,
    pricedOn: dates[dates.length - 1] ?? null,
  };
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** "Have 1, from other decks 3, buy 6 ($5.00), print 28": what getting a plan's cards takes. */
export function getLine(c: PlanCounts): string {
  const parts: string[] = [];
  if (c.have) parts.push(`have ${c.have}`);
  if (c.move) parts.push(`from other decks ${c.move}`);
  if (c.buy) parts.push(`buy ${c.buy}${c.buyUsd != null ? ` (${money(c.buyUsd)}${c.buyUnpriced ? `, ${c.buyUnpriced} unpriced` : ""})` : " (no prices yet)"}`);
  if (c.print) parts.push(`print ${c.print}`);
  const s = parts.join(", ");
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Nothing to get";
}

/**
 * Whether an answer approves a change: a want, given after the change last changed. A proposal a
 * plan file or note save edited after it was answered is unanswered again (server `versions.rs`).
 */
export function approves(s: Swap, answer: Review | undefined): boolean {
  return answer?.decision === "want" && (s.stage !== "proposed" || !s.updated_at || !answer.at || s.updated_at <= answer.at);
}

/** The changes in a plan's version waiting for your OK, in plan order. */
export function waitingSwaps(plan: DeckPlanState, swaps: Swap[]): Swap[] {
  if (!plan.next) return [];
  const byKey = new Map(swaps.map((s) => [s.key, s]));
  return plan.next.keys.map((k) => byKey.get(k)).filter((s): s is Swap => !!s);
}

/**
 * The changes in the plan in force: planned swaps (not stand-ins or optional extras) and the
 * proposals you approved (a want answer, once the plan has a version).
 */
export function inForceSwaps(deck: PlanDeck, plan: DeckPlanState, swaps: Swap[], answers: Map<string, Review>): Swap[] {
  if (plan.version == null) return [];
  return swaps
    .filter((s) => s.deck === deck.key && !s.retired && s.role === "swap")
    .filter((s) => s.stage === "planned" || approves(s, answers.get(s.key)))
    .sort((a, b) => (a.stage === b.stage ? a.sort - b.sort : a.stage === "planned" ? -1 : 1));
}

/** Where one change in a plan in progress stands. */
export type ChangeStep = "in" | "in_hand" | "to_buy" | "on_order" | "to_print" | "to_move";

export const STEP_LABEL: Record<ChangeStep, string> = {
  in: "In the deck",
  in_hand: "In hand, ready to put in",
  to_buy: "To buy",
  on_order: "On a print order",
  to_print: "On the next print order",
  to_move: "To move from another deck",
};

export function changeStep(s: Swap, marks: { installed?: Mark; bought?: Mark } | undefined, orders: Map<string, Order>): ChangeStep {
  if (installedState(s, marks?.installed).on) return "in";
  const kind = changeKind(s);
  if (kind === "have") return "in_hand";
  if (kind === "move") return "to_move";
  if (kind === "buy") return s.order_item || marks?.bought?.value ? "in_hand" : "to_buy";
  const order = s.print_order ? orders.get(s.print_order) : undefined;
  if (order?.status === "received") return "in_hand";
  if (order?.status === "placed") return "on_order";
  return "to_print";
}

/** "put in 3 cards you have", "buy 2", …: the next thing a plan in progress needs. Null when every change is in. */
export function nextStep(steps: ChangeStep[]): string | null {
  const n = (k: ChangeStep) => steps.filter((x) => x === k).length;
  const cards = (k: number) => (k === 1 ? "1 card" : `${k} cards`);
  if (n("in_hand")) return `put in ${cards(n("in_hand"))} you have`;
  if (n("to_buy")) return `buy ${cards(n("to_buy"))}`;
  if (n("to_move")) return `move ${cards(n("to_move"))} from other decks`;
  if (n("to_print")) return `print ${cards(n("to_print"))}`;
  if (n("on_order")) return `wait for ${cards(n("on_order"))} on order`;
  return null;
}

/** "proposed 5 Nov 2026 in the commander-decks plan file, version 35", "from your note “Buildable now”". */
export function sourceText(source: VersionSource | Record<string, unknown> | null | undefined, at: string | null | undefined, head?: PlanHead | null): string {
  const when = at ? ` ${fmtDate(at)}` : "";
  const s = (source ?? {}) as Record<string, unknown>;
  switch (s.kind) {
    case "plan_file": {
      const app = (s.app as string | null | undefined) ?? head?.app ?? null;
      const gv = (s.guide_version as number | null | undefined) ?? null;
      return `proposed${when} in ${app ? `the ${app} plan file` : "your plan file"}${gv != null ? `, version ${gv}` : ""}`;
    }
    case "note":
      return `from your note${s.title ? ` “${String(s.title)}”` : ""}${when ? `,${when}` : ""}`;
    case "before_versions":
      return "in progress before plans had versions";
    default:
      return `made in Yama${when ? `,${when}` : ""}`;
  }
}

/** The plain line under a plan's title: version, date and source (never a chip). */
export function versionLine(plan: DeckPlanState, head?: PlanHead | null): string {
  if (plan.state === "waiting" && plan.next) return `Version ${plan.next.n}, ${sourceText(plan.next.source, plan.next.proposed_at, head)}`;
  if (plan.version == null) return "";
  const approved = plan.approved_at ? `, approved ${fmtDate(plan.approved_at)}` : head ? `, from ${head.app ?? "your plan file"}` : "";
  return `Version ${plan.version}${approved}`;
}

/** Every plan op still on this device, by deck, newest last: the page shows them as done. */
export interface PlanDecision {
  deck_key: string;
  action: "approve" | "keep" | "undo" | "archive" | "restore";
  version: number | null;
}

/**
 * A deck's plan with this device's own decisions laid over it until a bundle that has them
 * arrives: an approval reads as in progress at that version, keep as nothing waiting, archive as
 * archived. Undo and restore wait for the bundle.
 */
export function overlayPlan(plan: DeckPlanState, decisions: PlanDecision[]): DeckPlanState {
  let p = plan;
  for (const d of decisions) {
    if (d.action === "approve" && p.next && d.version === p.next.n) {
      p = { ...p, state: "in_progress", version: p.next.n, approved_at: null, changes: p.changes + p.next.keys.length, next: null };
    } else if (d.action === "keep" && p.next && d.version === p.next.n) {
      p = { ...p, next: null };
    } else if (d.action === "archive" && p.state !== "archived") {
      p = { ...p, state: "archived", archived_note: "Archived by you" };
    }
  }
  return p;
}

/**
 * The bundle as Get the cards reads it: only the plans in force, and in them only planned swaps and
 * the proposals you approved. A plan waiting for your OK, archived or empty reads as archived, so
 * every shopping, print and spares view leaves it out; nothing is bought or printed before you
 * approve. With `deck`, only that deck's plan.
 */
export function inForceBundle<B extends Pick<PlanBundle, "decks" | "swaps">>(b: B, planOfDeck: (d: PlanDeck) => DeckPlanState, answers: Map<string, Review>, deck?: string | null): B {
  const live = new Set(b.decks.filter((d) => inForce(planOfDeck(d)) && (!deck || d.key === deck)).map((d) => d.key));
  return {
    ...b,
    decks: b.decks.map((d) => (live.has(d.key) ? d : { ...d, status: "archived" as const })),
    swaps: b.swaps.filter((s) => live.has(s.deck) && (s.stage === "planned" || approves(s, answers.get(s.key)))),
  };
}

// ── approval checks ────────────────────────────────────────────────────────

const BASICS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes"]);
const nameKey = (n: string) => n.trim().toLowerCase();
const isBasic = (n: string) => BASICS.has(nameKey(n).replace(/^snow-covered /, ""));
/** A swap's copies (`key#2`) are one change: they never clash with each other. */
const baseKey = (k: string) => k.replace(/#\d+$/, "");

export interface PlanProblems {
  /** Why each kept change can't be approved as it is, by key. */
  byKey: Map<string, string>;
  /** How many problems: a clash between several changes counts once. */
  count: number;
}

/**
 * The checks a version passes before you approve it (the plans redesign's New version board):
 * every kept swap names a card to cut, no cut is one the plan in force already takes out, and no
 * two kept changes cut the same card (basic lands aside). Skipping a change settles its problem.
 * The server refuses an approval on the same rule (`versions.rs` `problems`).
 */
export function planProblems(cuts: PlanCut[] | undefined, skipped: Set<string>): PlanProblems {
  const kept = (cuts ?? []).filter((c) => !skipped.has(c.key));
  const byKey = new Map<string, string>();
  const groups = new Set<string>();
  let count = 0;
  for (const c of kept) {
    const out = c.out?.trim();
    if (!out) {
      byKey.set(c.key, "No card named to cut. Skip it, or ask your assistant for one.");
      count++;
      continue;
    }
    if (isBasic(out)) continue;
    if (c.gone_for) {
      byKey.set(c.key, `Out of date: ${out} already goes out for ${c.gone_for}.`);
      count++;
      continue;
    }
    const same = kept.filter((d) => baseKey(d.key) !== baseKey(c.key) && !d.gone_for && d.out && nameKey(d.out) === nameKey(out));
    if (!same.length) continue;
    const others = [...new Set(same.map((d) => d.in).filter((n) => n !== c.in))];
    byKey.set(c.key, others.length ? `Same cut as ${others.join(" and ")}. Keep one of them.` : `Another change also puts in ${c.in} for ${out}. Keep one of them.`);
    if (!groups.has(nameKey(out))) {
      groups.add(nameKey(out));
      count++;
    }
  }
  return { byKey, count };
}

/** Changes that start skipped: the ones you said no to, and cuts the plan in force already makes. */
export function startSkipped(next: NonNullable<DeckPlanState["next"]>): Set<string> {
  return new Set([...next.skipped, ...(next.cuts ?? []).filter((c) => c.gone_for).map((c) => c.key)]);
}
