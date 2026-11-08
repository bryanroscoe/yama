import { describe, expect, it } from "vitest";
import { changeKind, changePrice, changeStep, countChanges, getLine, inForceSwaps, nextStep, overlayPlan, planChange, planOf, planProblems, sourceText, startSkipped, versionLine } from "./plans";
import { overlayReviews } from "./overlay";
import type { DeckPlanState, PlanDeck, Review, Swap } from "./types";

function swap(over: Partial<Swap>): Swap {
  return {
    key: "k", deck: "blight", stage: "proposed", role: "swap", parent: null, src: "buy", src_declared: null, store_label: null, out: "Old", in: "New",
    plan_card: null, later_out: null, after_print: false, tier: null, band: null, group: null, sort: 0, game_changer: null, got: null, order_item: null,
    print_order: null, listing: null, when: null, advice: null, why: null, why_out: null, note: null, upgrade: null, retired: false, retired_at: null,
    updated_at: "2026-11-01T00:00:00Z", ...over,
  };
}

const plan = (over: Partial<DeckPlanState> = {}): DeckPlanState => ({
  state: "waiting", version: null, approved_at: null, next: { n: 1, keys: ["a", "b"], skipped: [], proposed_at: "2026-11-05T10:00:00Z", source: { kind: "plan_file", app: "commander-decks", guide_version: 35 }, hash: "h" },
  changes: 0, installed: 0, questions: [], archived_at: null, archived_note: null, ...over,
});

const prices = { quotes: [], stores: [{ key: "ms", name: "Mothership", short: null, kind: "local" as const, cart_url_template: null, homepage: null, location: null, note: null, print_tiers: null, sort: 1, origin: "import", retired: false, retired_at: null }],
  market: { o1: { usd: 0.4, printing: "X", set: "x", num: "1", scryfall_id: "s", date: "2026-11-01", source: "TCGplayer market via Scryfall, cheapest non-foil" } },
  market_by_printing: {}, printing_ids: {}, names: { Farseek: "o1" }, prices_as_of: "2026-11-01" };

describe("a plan's changes", () => {
  it("say where each card comes from", () => {
    expect(changeKind(swap({ src: "print" }))).toBe("print");
    expect(changeKind(swap({ src: "buy" }))).toBe("buy");
    expect(changeKind(swap({ src: "owned", got: { how: "deck", deck: "trance", deck_name: "Revival Trance", origin: "precon" } }))).toBe("move");
    expect(changeKind(swap({ src: "owned", got: { how: "deck", deck: "blight", origin: "precon" } }))).toBe("have");
    expect(changeKind(swap({ src: "owned", got: { how: "pulled", product: "A booster" } }))).toBe("have");
  });

  it("price a buy from the store's newest in-stock listing, else the market, else not at all", () => {
    const s = swap({ key: "f", in: "Farseek" });
    expect(changePrice(s, prices)).toEqual({ usd: 0.4, date: "2026-11-01", store: null });
    const listed = { ...prices, quotes: [
      { swap: "f", card: "Farseek", kind: "stock_check" as const, store: "ms", store_label: null, checked: "2026-10-28", result: null, in_stock: true, price: 0.75, price_from_text: false, currency: "USD", printing: null, set: null, num: null, printing_from_text: false, scryfall_id: null, variant: null, url: null, source: "Store", origin: "import" },
    ] };
    expect(changePrice(s, listed)).toEqual({ usd: 0.75, date: "2026-10-28", store: "Mothership" });
    expect(changePrice(swap({ in: "Unknown" }), prices)).toBeNull();
  });

  it("count and say what getting them takes, with a missing price never counted as $0", () => {
    const name = (k: string | null | undefined) => k ?? "";
    const changes = [
      planChange(swap({ key: "f", in: "Farseek" }), prices, name),
      planChange(swap({ key: "u", in: "Unknown" }), prices, name),
      planChange(swap({ key: "p", src: "print" }), prices, name),
      planChange(swap({ key: "m", src: "owned", got: { how: "deck", deck: "trance", deck_name: "Revival Trance", origin: "precon" } }), prices, name),
    ];
    const c = countChanges(changes);
    expect(c).toMatchObject({ total: 4, buy: 2, print: 1, move: 1, have: 0, buyUsd: 0.4, buyUnpriced: 1 });
    expect(getLine(c)).toBe("From other decks 1, buy 2 ($0.40, 1 unpriced), print 1");
    expect(changes[3]!.from).toBe("Revival Trance");
  });
});

describe("a plan's state", () => {
  it("reads an older bundle's deck as a plan", () => {
    const deck = { key: "blight", status: "proposals_only", notes: [] } as unknown as PlanDeck;
    expect(planOf(deck, [swap({ key: "a" })]).state).toBe("waiting");
    expect(planOf({ ...deck, status: "active" }, [swap({ key: "a", stage: "planned" })]).state).toBe("in_progress");
  });

  it("has a plain version line", () => {
    expect(versionLine(plan())).toBe("Version 1, proposed 5 Nov 2026 in the commander-decks plan file, version 35");
    expect(versionLine(plan({ state: "in_progress", version: 2, approved_at: "2026-11-06" }))).toBe("Version 2, approved 6 Nov 2026");
    expect(sourceText({ kind: "note", note: "n", title: "Buildable now" }, null)).toBe("from your note “Buildable now”");
  });

  it("counts the approved proposals in the plan in force", () => {
    const deck = { key: "blight" } as PlanDeck;
    const answers = new Map<string, Review>([["b", { decision: "want" } as Review]]);
    const swaps = [swap({ key: "a", stage: "planned" }), swap({ key: "b" }), swap({ key: "c" }), swap({ key: "s", stage: "planned", role: "standin" })];
    expect(inForceSwaps(deck, plan({ state: "in_progress", version: 1 }), swaps, answers).map((s) => s.key)).toEqual(["a", "b"]);
    expect(inForceSwaps(deck, plan(), swaps, answers)).toEqual([]);
  });

  it("says what's next", () => {
    const orders = new Map();
    expect(changeStep(swap({ src: "buy" }), undefined, orders)).toBe("to_buy");
    expect(changeStep(swap({ src: "buy" }), { bought: { value: true, at: "", payload: {} } }, orders)).toBe("in_hand");
    expect(changeStep(swap({ src: "buy", deck_installed: true }), undefined, orders)).toBe("in");
    expect(nextStep(["in", "to_buy", "to_print"])).toBe("buy 1 card");
    expect(nextStep(["in_hand", "in_hand"])).toBe("put in 2 cards you have");
    expect(nextStep(["in"])).toBeNull();
  });

  it("shows this device's decisions until the bundle has them", () => {
    const approved = overlayPlan(plan(), [{ deck_key: "blight", action: "approve", version: 1 }]);
    expect(approved).toMatchObject({ state: "in_progress", version: 1, next: null, changes: 2 });
    expect(overlayPlan(plan(), [{ deck_key: "blight", action: "approve", version: 2 }]).state).toBe("waiting");
    expect(overlayPlan(plan(), [{ deck_key: "blight", action: "archive", version: null }]).state).toBe("archived");
    const reviews = overlayReviews({}, [{ local: "pending", op: { kind: "plan", op_id: "o", at: "2026-11-06T00:00:00Z", deck_key: "blight", action: "approve", version: 1, keys: ["a"], skip: ["b"], answers: [] } }]);
    expect(reviews.a?.decision).toBe("want");
    expect(reviews.b?.decision).toBe("no");
  });
});

describe("approval checks", () => {
  // Riders of Rohan's version 2 as it waits on 8 Nov: two pairs share a cut, one names none, and
  // Banishing Light's cut already goes out for Raise the Palisade.
  const cuts = [
    { key: "banish", in: "Banishing Light", out: "Earthquake", gone_for: "Raise the Palisade" },
    { key: "archangel", in: "Archangel of Tithes", out: "Frontier Warmonger", gone_for: null },
    { key: "aetherize", in: "Aetherize", out: null, gone_for: null },
    { key: "borrower", in: "Brazen Borrower", out: "Wayfarer's Bauble", gone_for: null },
    { key: "eomer", in: "Éomer, King of Rohan", out: "Wayfarer's Bauble", gone_for: null },
    { key: "devotion", in: "Increasing Devotion", out: "frontier warmonger", gone_for: null },
    { key: "land-1", in: "Tundra", out: "Plains", gone_for: null },
    { key: "land-2", in: "Plateau", out: "Plains", gone_for: null },
    { key: "n|x", in: "Rats", out: "Thing", gone_for: null },
    { key: "n|x#2", in: "Rats", out: "Thing", gone_for: null },
  ];
  it("name each problem beside its change, and count a clash once", () => {
    const p = planProblems(cuts, new Set());
    expect(p.count).toBe(4);
    expect(p.byKey.get("banish")).toBe("Out of date: Earthquake already goes out for Raise the Palisade.");
    expect(p.byKey.get("aetherize")).toMatch(/^No card named to cut/);
    expect(p.byKey.get("borrower")).toBe("Same cut as Éomer, King of Rohan. Keep one of them.");
    expect(p.byKey.get("devotion")).toBe("Same cut as Archangel of Tithes. Keep one of them.");
    expect(p.byKey.has("land-1") || p.byKey.has("n|x")).toBe(false);
  });
  it("are settled by skipping", () => {
    const skipped = startSkipped({ n: 2, keys: [], skipped: ["aetherize"], proposed_at: null, source: { kind: "yama" }, hash: "h", cuts });
    expect([...skipped].sort()).toEqual(["aetherize", "banish"]);
    expect(planProblems(cuts, skipped).count).toBe(2);
    skipped.add("eomer");
    skipped.add("devotion");
    expect(planProblems(cuts, skipped)).toEqual({ byKey: new Map(), count: 0 });
  });
  it("pass a bundle from before the checks", () => {
    expect(planProblems(undefined, new Set()).count).toBe(0);
  });
});

describe("approving", () => {
  it("takes a want given after the change last changed", async () => {
    const { approves } = await import("./plans");
    const s = swap({ updated_at: "2026-11-05T00:00:00Z" });
    expect(approves(s, { decision: "want", at: "2026-11-06T00:00:00Z" } as Review)).toBe(true);
    expect(approves(s, { decision: "want", at: "2026-11-04T00:00:00Z" } as Review)).toBe(false);
    expect(approves({ ...s, stage: "planned" }, { decision: "want", at: "2026-11-04T00:00:00Z" } as Review)).toBe(true);
    expect(approves(s, { decision: "unsure", at: "2026-11-06T00:00:00Z" } as Review)).toBe(false);
  });
});

describe("Get the cards", () => {
  it("reads only the plans in force, and only what was approved in them", async () => {
    const { inForceBundle } = await import("./plans");
    const decks = [
      { key: "a", status: "active", plan: plan({ state: "in_progress", version: 1, next: null }) },
      { key: "w", status: "proposals_only", plan: plan() },
    ] as unknown as PlanDeck[];
    const swaps = [swap({ key: "1", deck: "a", stage: "planned" }), swap({ key: "2", deck: "a" }), swap({ key: "3", deck: "a" }), swap({ key: "4", deck: "w" })];
    const answers = new Map<string, Review>([["2", { decision: "want" } as Review], ["4", { decision: "want" } as Review]]);
    const g = inForceBundle({ decks, swaps }, (d) => d.plan!, answers);
    expect(g.swaps.map((s) => s.key)).toEqual(["1", "2"]);
    expect(g.decks.map((d) => d.status)).toEqual(["active", "archived"]);
    expect(inForceBundle({ decks, swaps }, (d) => d.plan!, answers, "w").swaps).toEqual([]);
  });
});
