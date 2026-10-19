// The overview's figures (docs/planner-design.md section 7, `overviewCounts`), and which planned
// swaps have their card in hand, ready for an "I've put this in the deck" tick.

import { buyList, type BuyData } from "./buy";
import { deckLogs, type DeckLogs } from "./changes";
import type { MarkPair } from "./marks";
import { printPlan, type PrintData } from "./prints";
import { spares, type SpareData } from "./spares";
import type { PlanDeck, Review, Swap } from "./types";

/**
 * Whether a planned swap's card is in hand now, from the now list's log: a buy or move done, an
 * optional extra in its slot, a stand-in in the deck. Prints aren't until the plan records them
 * arriving. Proposals never are.
 */
export function inHand(s: Swap, logs: DeckLogs): boolean {
  if (s.stage !== "planned" || s.retired) return false;
  if (s.role === "standin") return logs.nowNames.has(s.in);
  const st = logs.now.get(s.key);
  return st === "done" || st === "moved";
}

export interface OverviewCounts {
  /** Proposals with no answer yet. */
  toReview: number;
  /** Buy list rows (not marked bought), their listed total, and how many have no price. */
  toBuy: number;
  buyTotal: number;
  buyUnpriced: number;
  /** Marked bought, waiting for the plan to record an order. */
  markedBought: number;
  printsOnOrder: number;
  printsArrived: number;
  printsNext: number;
  /** Planned swaps in hand now with no installed tick. */
  waitingToInstall: number;
  installed: number;
  /** Spares free now (not taken by another deck's plan), and those that come free when prints arrive. */
  sparesNow: number;
  sparesLater: number;
}

export interface OverviewInput {
  answers: Map<string, Review>;
  marks: Map<string, MarkPair>;
  today: string;
}

export function overviewCounts(b: BuyData & PrintData & SpareData, opts: OverviewInput): OverviewCounts {
  const active = new Map<string, PlanDeck>(b.decks.filter((d) => d.status !== "archived").map((d) => [d.key, d]));
  const live = b.swaps.filter((s) => !s.retired && active.has(s.deck));
  const buy = buyList(b, { answers: opts.answers, marks: opts.marks });
  const prints = printPlan(b, { answers: opts.answers, today: opts.today });
  const sp = spares(b, opts.answers);
  const logs = new Map([...active].map(([k, d]) => [k, deckLogs(d)]));
  let waiting = 0;
  let installed = 0;
  for (const s of live) {
    const ticked = !!opts.marks.get(s.key)?.installed?.value;
    if (ticked) installed += 1;
    else if (inHand(s, logs.get(s.deck)!)) waiting += 1;
  }
  return {
    toReview: live.filter((s) => s.stage === "proposed" && !opts.answers.get(s.key)?.decision).length,
    toBuy: buy.count,
    buyTotal: buy.total,
    buyUnpriced: buy.unpriced,
    markedBought: buy.marked.length,
    printsOnOrder: prints.placed.reduce((n, o) => n + o.count, 0),
    printsArrived: prints.received.reduce((n, o) => n + o.count, 0),
    printsNext: prints.next.count,
    waitingToInstall: waiting,
    installed,
    sparesNow: sp.now.filter((x) => x.free).length + sp.extras.filter((x) => x.free).length,
    sparesLater: sp.after.filter((x) => x.free).length,
  };
}
