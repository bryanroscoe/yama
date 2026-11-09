// The deck page's Plan tab (deck page SPEC, section 0, "The Plan tab is the deck's plan hub"): the
// deck's plan in progress, the plans for it waiting for your OK, the ideas you sent for it that are still open, and how many earlier plans there are.
// Everything comes from the plan bundle (one plan per deck, by state) and the research notes list.

import { inForce, nextStep, type DeckPlanState, type Idea, type IdeaOp, type PlanDeck } from "@yama/core/plan";
import { progressSteps, waitingCounts } from "../plan/Plans";
import type { PlanView } from "../plan/view";
import type { PlanSummary } from "../research/view";

export interface UpNext {
  deck: PlanDeck;
  plan: DeckPlanState;
  /** "Version 3 of this plan", "A Bracket 3 build", "A new plan". */
  label: string;
  changes: number;
  /** Review opens the plan's page, at its new version when it's one. */
  hash: "" | "#new-version";
}

export interface DeckPlanHub {
  /** The approved plan in force (in progress or done), with where each change stands. */
  current: { deck: PlanDeck; plan: DeckPlanState; steps: ReturnType<typeof progressSteps>; installed: number; next: string | null } | null;
  upNext: UpNext[];
  /** Changes you suggested for this deck's plans that the planner hasn't settled yet. */
  ideas: Idea[];
  /** Archived plans, earlier versions and research notes for this deck. */
  earlier: number;
}

/** The plan decks linked to a Yama deck, in the plans' order. */
function decksFor(view: PlanView, deckId: string): PlanDeck[] {
  return view.b.decks.filter((p) => p.deck_id === deckId).sort((a, b) => a.sort - b.sort);
}

/** What a plan in progress needs next, as the Plans page's tile says it. */
export function nextLine(plan: DeckPlanState, steps: { step: Parameters<typeof nextStep>[0][number] }[]): string | null {
  if (plan.next) return "OK the new version";
  if (plan.questions.length) return plan.questions.length === 1 ? "answer the open question" : `answer ${plan.questions.length} open questions`;
  return nextStep(steps.map((s) => s.step));
}

/**
 * `local`: idea ops still in this device's outbox (waiting to sync, or sent but not yet in a
 * refreshed bundle), so an idea sent from the deck page shows at once.
 */
export function deckPlanHub(view: PlanView, deckId: string, notes: PlanSummary[] = [], deckName = "", local: IdeaOp[] = []): DeckPlanHub {
  const mine = decksFor(view, deckId).map((deck) => ({ deck, plan: view.planOf(deck) }));
  const live = mine.filter((r) => r.deck.status !== "archived" && r.plan.state !== "archived");
  const held = live.find((r) => inForce(r.plan));
  let current: DeckPlanHub["current"] = null;
  if (held) {
    const steps = progressSteps(view, held.deck, held.plan);
    current = { ...held, steps, installed: steps.filter((s) => s.step === "in").length, next: nextLine(held.plan, steps) };
  }
  const upNext: UpNext[] = [];
  for (const r of live) {
    if (!r.plan.next) continue;
    const changes = waitingCounts(view, r.deck, r.plan).total;
    if (inForce(r.plan)) {
      upNext.push({ ...r, label: `Version ${r.plan.next.n} of this plan`, changes, hash: "#new-version" });
    } else if (r.plan.state === "waiting") {
      const target = r.deck.bracket?.target ?? r.deck.bracket?.box ?? null;
      // Another build beside the one in progress names its bracket; a deck's only plan is "A new plan".
      const label = held && target != null ? `A Bracket ${target} build` : "A new plan";
      upNext.push({ ...r, label, changes, hash: "" });
    }
  }
  const keys = new Set(mine.map((r) => r.deck.key));
  const archivedDecks = mine.filter((r) => r.deck.status === "archived" || r.plan.state === "archived").length;
  const versions = new Set((view.b.versions ?? []).filter((v) => keys.has(v.deck) && (v.superseded_at || v.status === "kept")).map((v) => `${v.deck}/${v.n}`)).size;
  // A note plans this deck when one of its plans tracks the note's deck, or (as the Plans page's
  // groups did) the note's deck has the deck's name.
  const tracked = new Set(mine.flatMap((r) => (r.deck.note ? [`${r.deck.note.id}\0${r.deck.note.deck}`] : [])));
  const names = new Set([deckName, ...mine.map((r) => r.deck.name)].map((n) => n.trim().toLowerCase()).filter(Boolean));
  const noteCount = notes.filter((n) => (n.deck_plans ?? []).some((p) => tracked.has(`${n.id}\0${p.key}`) || names.has(p.name.trim().toLowerCase()))).length;
  const liveKeys = new Set(live.map((r) => r.deck.key));
  const stored = view.b.inputs?.ideas ?? [];
  const seen = new Set(stored.map((i) => i.op_id));
  // A local idea hasn't reached the planner: no seq yet, so it reads as waiting.
  const queued: Idea[] = local
    .filter((op) => !seen.has(op.op_id))
    .map((op) => ({ op_id: op.op_id, seq: Number.POSITIVE_INFINITY, deck_key: op.deck_key, in: op.in, out: op.out, why: op.why, at: op.at, outcome: null, outcome_at: null }));
  const ideas = [...stored, ...queued].filter((i) => i.deck_key != null && liveKeys.has(i.deck_key) && !i.outcome);
  return { current, upNext, ideas, earlier: archivedDecks + versions + noteCount };
}

/** The Plan tab's note: "3 of 12 in" when the deck has a plan in force. */
export function planTabNote(plan: { view: PlanView; deck: PlanDeck } | null | undefined): string | null {
  if (!plan?.deck.deck_id) return null;
  const c = deckPlanHub(plan.view, plan.deck.deck_id).current;
  return c ? `${c.installed} of ${c.steps.length} in` : null;
}
