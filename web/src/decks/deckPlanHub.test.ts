import type { DeckPlanState, PlanBundle, PlanDeck, Swap } from "@yama/core/plan";
import { describe, expect, it } from "vitest";
import { planView } from "../plan/view";
import type { PlanSummary } from "../research/view";
import { deckPlanHub, planTabNote } from "./deckPlanHub";

const state = (over: Partial<DeckPlanState>): DeckPlanState => ({
  state: "in_progress", version: 1, approved_at: null, next: null, changes: 0, installed: 0, questions: [], archived_at: null, archived_note: null, ...over,
});
const next = (n: number, keys: string[]): DeckPlanState["next"] => ({ n, keys, skipped: [], proposed_at: null, source: { kind: "yama" }, hash: "h" });

const deck = (key: string, plan: DeckPlanState, over: Partial<PlanDeck> = {}): PlanDeck => ({
  key, name: "Terra", source: "yama", status: "active", product: null, commander: ["Terra"], color_identity: "WBR", owner_changes: [], bracket: null,
  groups: [], notes: [], deck_id: "d1", sort: 0, updated_at: "", states: {}, plan, ...over,
});

const swap = (key: string, deckKey: string, over: Partial<Swap> = {}): Swap => ({
  key, deck: deckKey, stage: "planned", role: "swap", parent: null, src: "owned", src_declared: null, store_label: null, out: `Out ${key}`, in: `In ${key}`,
  plan_card: null, later_out: null, after_print: false, tier: null, band: null, group: null, sort: 0, game_changer: null, got: null, order_item: null,
  print_order: null, listing: null, when: null, advice: null, why: null, why_out: null, note: null, upgrade: null, retired: false, retired_at: null, updated_at: "", ...over,
});

function bundle(decks: PlanDeck[], swaps: Swap[], extra: Partial<PlanBundle> = {}): PlanBundle {
  return {
    rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, settings: [], stores: [], decks, swaps, aliases: {}, orders: [], quotes: [],
    reviews: {}, marks: {}, inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] }, names: {}, unresolved: [], cards: {},
    market: {}, market_by_printing: {}, printing_ids: {}, prices_as_of: null, ...extra,
  } as PlanBundle;
}

describe("the deck page's Plan tab", () => {
  const swaps = [
    swap("a", "terra", { deck_installed: true }),
    swap("b", "terra", { deck_installed: false, sort: 1 }),
    swap("c", "terra", { deck_installed: false, src: "buy", sort: 2 }),
    swap("w1", "terra", { stage: "proposed" }),
    swap("x", "terra-b3", { stage: "proposed" }),
    swap("y", "terra-b3", { stage: "proposed" }),
  ];
  const decks = [
    deck("terra", state({ next: next(2, ["w1"]) })),
    deck("terra-b3", state({ state: "waiting", version: null, next: next(1, ["x", "y"]) }), { bracket: { target: 3, box: 3 } as PlanDeck["bracket"], sort: 1 }),
    deck("terra-old", state({ state: "archived" }), { status: "archived", sort: 2 }),
    deck("other", state({}), { deck_id: "d2", name: "Other" }),
  ];
  const view = planView(
    bundle(decks, swaps, {
      versions: [
        { deck: "terra", deck_name: "Terra", n: 1, status: "approved", changes: [], skipped: [], answers: [], source: { kind: "yama" }, proposed_at: null, decided_at: "2026-11-01", superseded_at: "2026-11-02" },
        { deck: "other", deck_name: "Other", n: 1, status: "kept", changes: [], skipped: [], answers: [], source: { kind: "yama" }, proposed_at: null, decided_at: "2026-11-01", superseded_at: null },
      ],
      inputs: {
        pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [],
        ideas: [
          { op_id: "i1", seq: 1, deck_key: "terra", in: "Karmic Guide", out: "Sepulchral Primordial", why: null, at: "", outcome: null, outcome_at: null },
          { op_id: "i2", seq: 2, deck_key: "terra", in: "Settled", out: null, why: null, at: "", outcome: "Added", outcome_at: "" },
          { op_id: "i3", seq: 3, deck_key: "other", in: "Elsewhere", out: null, why: null, at: "", outcome: null, outcome_at: null },
        ],
      },
    }),
  );
  const note = (id: string, plans: { key: string; name: string }[]) => ({ id, deck_plans: plans }) as unknown as PlanSummary;

  it("shows the plan in force with where each change stands and the next step", () => {
    const hub = deckPlanHub(view, "d1");
    expect(hub.current?.deck.key).toBe("terra");
    expect(hub.current?.steps.map((s) => s.step)).toEqual(["in", "in_hand", "to_buy"]);
    expect(hub.current?.installed).toBe(1);
    // A new version waits: approving it comes first.
    expect(hub.current?.next).toBe("OK the new version");
  });

  it("lists the new version and another build waiting for your OK, each with its changes", () => {
    const hub = deckPlanHub(view, "d1");
    expect(hub.upNext.map((u) => [u.label, u.changes, u.hash])).toEqual([
      ["Version 2 of this plan", 1, "#new-version"],
      ["A Bracket 3 build", 2, ""],
    ]);
  });

  it("counts archived plans, earlier versions and notes for this deck only", () => {
    const notes = [note("n1", [{ key: "k", name: " terra " }]), note("n2", [{ key: "k", name: "Other" }])];
    expect(deckPlanHub(view, "d1", notes, "Terra").earlier).toBe(3);
    expect(deckPlanHub(view, "d1").earlier).toBe(2);
  });

  it("keeps only this deck's ideas that are still open", () => {
    expect(deckPlanHub(view, "d1").ideas.map((i) => i.op_id)).toEqual(["i1"]);
  });

  it("names a deck's only waiting plan a new plan, and says there's nothing for a deck with no plan", () => {
    const only = planView(bundle([deck("solo", state({ state: "waiting", version: null, next: next(1, ["s"]) }), { bracket: { target: 3 } as PlanDeck["bracket"] })], [swap("s", "solo", { stage: "proposed" })]));
    const hub = deckPlanHub(only, "d1");
    expect(hub.current).toBeNull();
    expect(hub.upNext.map((u) => u.label)).toEqual(["A new plan"]);
    expect(deckPlanHub(only, "nobody")).toEqual({ current: null, upNext: [], ideas: [], earlier: 0 });
  });

  it("notes the tab with how many changes are in", () => {
    expect(planTabNote({ view, deck: decks[0]! })).toBe("1 of 3 in");
    expect(planTabNote(null)).toBeNull();
    const waiting = planView(bundle([decks[1]!], swaps));
    expect(planTabNote({ view: waiting, deck: decks[1]! })).toBeNull();
  });

  it("puts an open question before the next card when nothing waits", () => {
    const q = planView(bundle([deck("terra", state({ questions: ["Karmic Guide or not?"] }))], swaps.slice(0, 3)));
    expect(deckPlanHub(q, "d1").current?.next).toBe("answer the open question");
    const plain = planView(bundle([deck("terra", state({}))], swaps.slice(0, 3)));
    expect(deckPlanHub(plain, "d1").current?.next).toBe("put in 1 card you have");
  });
});
