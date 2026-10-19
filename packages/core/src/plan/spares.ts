// Spare cards (docs/planner-design.md section 7, `spares`): every card a plan takes out of a deck,
// read from the stored lists the way commander-decks' library.py builds them, so a card counts as
// out only when its list says so.
//   Out now: the stock list with your own changes applied, minus the now list.
//   Out when prints arrive: the now list minus the after-prints list (stand-ins leaving, and cards
//   whose replacement waits for a print or for another deck to free it).
// A spare another deck's plan moves in is marked as used there; one an undecided proposal would use
// is marked "proposed for". A basic land is listed only when a plan swap cuts it.
//
// A stand-in's recorded later cut isn't applied: the lists treat every stand-in as spare once its
// print arrives. The later cut is shown as a suggestion, with what would change if you followed it.

import { BASICS } from "./text";
import type { Decision, PlanBundle, PlanDeck, Review, Slot, Swap } from "./types";

export interface SpareUse {
  deck: PlanDeck | undefined;
  swap: Swap;
  /** A plan move: in the now list, once prints arrive, or still waiting. Proposals: "proposed". */
  when: "now" | "after" | "waiting" | "proposed";
  decision: Decision | null;
}

export interface Spare {
  card: string;
  qty: number;
  from: PlanDeck;
  /** Out now; out when prints arrive; out before the plans (your own change); bought with no slot. */
  when: "now" | "after" | "before" | "extra";
  why: string;
  /** The swap that takes it out, or the stand-in's own swap. */
  swap: string | null;
  /** Set when the card is a stand-in leaving as its print arrives. */
  standin: Swap | null;
  /** The stand-in's later cut as recorded: a suggestion, not in the plan. */
  laterOut: string | null;
  /** Plan moves that take it into another deck. */
  usedIn: SpareUse[];
  /** Proposals (not answered no) that would use it. */
  proposedFor: SpareUse[];
  /** Not taken by another deck's plan. */
  free: boolean;
}

export interface Spares {
  now: Spare[];
  after: Spare[];
  before: Spare[];
  extras: Spare[];
}

export type SpareData = Pick<PlanBundle, "decks" | "swaps">;

function counts(cards: Slot[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cards ?? []) if (c.board === "main") m.set(c.name, (m.get(c.name) ?? 0) + c.qty);
  return m;
}

/**
 * Names `a` has more of than `b`. A basic land counts only as far as `b` has slots replacing it
 * (a plan swap cut it); the basic that holds a print's slot for now isn't a spare.
 */
function minus(a: Map<string, number>, b: Map<string, number>, bCards: Slot[]): [string, number][] {
  return [...a]
    .map(([n, q]) => {
      const extra = q - (b.get(n) ?? 0);
      if (!BASICS.has(n)) return [n, extra] as [string, number];
      const cut = bCards.filter((c) => c.board === "main" && c.replaces === n && c.kind !== "stock").reduce((k, c) => k + c.qty, 0);
      return [n, Math.min(extra, cut)] as [string, number];
    })
    .filter(([, q]) => q > 0);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every spare across the decks, from the stored lists. `answers` is keyed by live swap key. */
export function spares(b: SpareData, answers: Map<string, Review>): Spares {
  const decks = new Map(b.decks.map((d) => [d.key, d]));
  const live = b.swaps.filter((s) => !s.retired);
  const byKey = new Map(live.map((s) => [s.key, s]));
  const deckName = (k: string | null | undefined) => (k ? decks.get(k)?.name ?? k : "another deck");
  const logStatus = (deckKey: string, state: "now" | "after", swapKey: string) =>
    decks.get(deckKey)?.states[state]?.log.find((e) => e.swap === swapKey)?.status;

  const fromDeck = (s: Swap, d: PlanDeck) => s.got?.how === "deck" && (s.got.deck === d.key || (!s.got.deck && s.got.deck_name === d.name));
  const uses = (card: string, d: PlanDeck): { usedIn: SpareUse[]; proposedFor: SpareUse[] } => {
    const usedIn: SpareUse[] = [];
    const proposedFor: SpareUse[] = [];
    for (const s of live) {
      if (s.src !== "owned" || s.in !== card) continue;
      const target = decks.get(s.deck);
      if (!target || target.status === "archived") continue;
      // A proposal may put a spare back into the deck it left; a plan move goes to another deck.
      if (s.stage === "planned" && s.deck !== d.key && fromDeck(s, d)) {
        const when = logStatus(s.deck, "now", s.key) === "moved" ? "now" : logStatus(s.deck, "after", s.key) === "moved" ? "after" : "waiting";
        usedIn.push({ deck: target, swap: s, when, decision: answers.get(s.key)?.decision ?? null });
      } else if (s.stage === "proposed" && (s.got?.how !== "deck" || fromDeck(s, d))) {
        const decision = answers.get(s.key)?.decision ?? null;
        if (decision !== "no") proposedFor.push({ deck: target, swap: s, when: "proposed", decision });
      }
    }
    return { usedIn, proposedFor };
  };
  const spare = (card: string, qty: number, from: PlanDeck, when: Spare["when"], why: string, swap: string | null, standin: Swap | null = null): Spare => {
    const u = uses(card, from);
    return { card, qty, from, when, why, swap, standin, laterOut: standin?.later_out ?? null, ...u, free: u.usedIn.length === 0 };
  };

  const out: Spares = { now: [], after: [], before: [], extras: [] };
  for (const d of b.decks) {
    if (d.status === "archived") continue;
    const stock = d.states.stock?.cards;
    const nowCards = d.states.now?.cards ?? [];
    const afterCards = d.states.after?.cards ?? [];
    if (!stock || !d.states.now || !d.states.after) continue;

    // The deck as you had it before the plans: stock with your own changes.
    const base = counts(stock);
    for (const c of d.owner_changes) {
      if (!base.get(c.out)) continue;
      base.set(c.out, base.get(c.out)! - 1);
      base.set(c.in, (base.get(c.in) ?? 0) + 1);
      if (!BASICS.has(c.out)) out.before.push(spare(c.out, 1, d, "before", `Taken out for ${c.in}, your own change before the plans.`, null));
    }
    const now = counts(nowCards);
    const after = counts(afterCards);

    for (const [card, qty] of minus(base, now, nowCards)) {
      const slot = nowCards.find((c) => c.board === "main" && c.replaces === card);
      const sw = slot?.swap ? byKey.get(slot.swap) : undefined;
      let why = "Not in the now list.";
      if (slot) {
        switch (slot.kind) {
          case "bought":
            why = `Replaced by ${slot.name}, which you bought.`;
            break;
          case "standin": {
            const print = sw?.parent ? byKey.get(sw.parent)?.in : null;
            why = print ? `Replaced by the stand-in ${slot.name} until the ${print} print arrives.` : `Replaced by the stand-in ${slot.name}.`;
            break;
          }
          case "fill":
            why = sw ? `A basic land holds the slot until the ${sw.in} print arrives.` : "A basic land holds the slot for now.";
            break;
          case "moved":
            why = `Replaced by ${slot.name}, moved from ${deckName(slot.from_deck ?? (slot.got?.how === "deck" ? slot.got.deck : null))}.`;
            break;
          case "optional":
            why = `Replaced by the optional extra ${slot.name}.`;
            break;
          default:
            why = `Replaced by ${slot.name}.`;
        }
      }
      out.now.push(spare(card, qty, d, "now", why, slot?.swap ?? null));
    }

    for (const [card, qty] of minus(now, after, afterCards)) {
      const held = nowCards.find((c) => c.board === "main" && c.name === card && c.kind === "standin");
      const standin = held?.swap ? byKey.get(held.swap) ?? null : null;
      if (standin) {
        const print = standin.parent ? byKey.get(standin.parent)?.in : null;
        const why = print ? `A stand-in: leaves when the ${print} print arrives.` : "A stand-in: leaves when its print arrives.";
        out.after.push(spare(card, qty, d, "after", why, standin.key, standin));
        continue;
      }
      const slot = afterCards.find((c) => c.board === "main" && c.replaces === card);
      let why = "Not in the after-prints list.";
      if (slot?.kind === "print") why = `Leaves when the ${slot.name} print arrives.`;
      else if (slot?.kind === "moved") why = `Leaves when ${slot.name} moves in from ${deckName(slot.from_deck)}, once your prints arrive.`;
      else if (slot) why = `Replaced by ${slot.name} when your prints arrive.`;
      out.after.push(spare(card, qty, d, "after", why, slot?.swap ?? null));
    }

    const inNow = new Set(nowCards.map((c) => c.name));
    for (const s of live) {
      if (s.deck !== d.key || s.stage !== "planned" || s.role !== "optional" || s.out || inNow.has(s.in)) continue;
      out.extras.push(spare(s.in, 1, d, "extra", "Bought for this deck; the plan has no slot for it.", s.key));
    }
  }
  const order = (x: Spare, y: Spare) => cmp(x.card.toLowerCase(), y.card.toLowerCase()) || cmp(x.from.name, y.from.name);
  for (const list of Object.values(out)) list.sort(order);
  return out;
}

/** What following a stand-in's later cut would change, in words, or null when it has none. */
export function laterOutText(s: Spare): string | null {
  if (!s.standin || !s.laterOut) return null;
  return `Its later cut, ${s.laterOut}, is a suggestion and not part of the plan. If you keep ${s.card} when the print arrives and take out ${s.laterOut} instead, ${s.laterOut} is the spare, not ${s.card}.`;
}
