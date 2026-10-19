// Slice 4: ops, the device overlay and the review list, on a synthetic plan.
import { describe, expect, it } from "vitest";
import {
  answerIndex,
  answerState,
  filterItems,
  isClear,
  opTime,
  overlayMarks,
  overlayReviews,
  reviewItems,
  reviewRecord,
  toggleDecision,
  wins,
  type LocalOp,
  type PlanDeck,
  type Quote,
  type Review,
  type ReviewOp,
  type Store,
  type Swap,
} from "./index";

const swap = (over: Partial<Swap> & Pick<Swap, "key" | "in">): Swap => ({
  deck: "alpha", stage: "planned", role: "swap", parent: null, src: "buy", src_declared: null, store_label: null, out: null,
  plan_card: null, later_out: null, after_print: false, tier: null, band: null, group: null, sort: 0, game_changer: null, got: null,
  order_item: null, print_order: null, listing: null, when: null, advice: null, why: null, why_out: null, note: null, upgrade: null,
  retired: false, retired_at: null, updated_at: "2026-10-19T00:00:00Z", ...over,
});

const deck = (key: string, sort: number, status: PlanDeck["status"] = "active"): PlanDeck =>
  ({ key, name: key.toUpperCase(), source: "import", status, product: null, commander: ["C"], color_identity: "G", owner_changes: [],
     bracket: null, groups: [], notes: [], deck_id: null, sort, updated_at: "", states: {} }) as PlanDeck;

const answer = (over: Partial<Review>): Review => ({ decision: "want", note: null, cut: null, deck: null, card: null, at: "2026-10-19T01:00:00Z", origin: "yama", ...over });

const op = (over: Partial<ReviewOp> & Pick<ReviewOp, "op_id" | "swap_key" | "at">): ReviewOp => ({
  kind: "review", deck_key: "alpha", decision: "want", note: null, cut: null, ...over,
});

describe("last writer wins, as the server decides", () => {
  it("prefers the later time, then Yama over an import, then the larger op id", () => {
    expect(wins({ at: "2026-10-19T02:00:00Z" }, { at: "2026-10-19T01:00:00Z", origin: "import" })).toBe(true);
    expect(wins({ at: "2026-10-19T01:00:00Z", origin: "yama" }, { at: "2026-10-19T02:00:00Z", origin: "import" })).toBe(false);
    expect(wins({ at: "2026-10-19T01:00:00Z", origin: "yama", op_id: "a" }, { at: "2026-10-19T01:00:00Z", origin: "import" })).toBe(true);
    expect(wins({ at: "2026-10-19T01:00:00Z", origin: "import" }, { at: "2026-10-19T01:00:00Z", origin: "yama", op_id: "a" })).toBe(false);
    expect(wins({ at: "2026-10-19T01:00:00Z", op_id: "b" }, { at: "2026-10-19T01:00:00Z", op_id: "a" })).toBe(true);
    expect(wins({ at: "2026-10-19T01:00:00Z", op_id: "a" }, { at: "2026-10-19T01:00:00Z", op_id: "a" })).toBe(false);
    expect(wins({ at: "2026-10-19T01:00:00Z" }, undefined)).toBe(true);
  });

  it("writes times as the server keeps them: UTC, whole seconds", () => {
    expect(opTime(new Date("2026-10-19T01:02:03.987Z"))).toBe("2026-10-19T01:02:03Z");
  });
});

describe("full records", () => {
  it("sends the whole answer with one change, blank text as none", () => {
    const current = answer({ decision: "unsure", note: "check price", cut: "Forest" });
    expect(reviewRecord(current, { decision: "want" })).toEqual({ decision: "want", note: "check price", cut: "Forest" });
    expect(reviewRecord(current, { note: "   " })).toEqual({ decision: "unsure", note: null, cut: "Forest" });
    expect(reviewRecord(undefined, { cut: "" })).toEqual({ decision: null, note: null, cut: null });
  });

  it("clears a decision tapped again, and an empty record is a clear", () => {
    expect(toggleDecision("want", "want")).toBeNull();
    expect(toggleDecision("want", "no")).toBe("no");
    expect(toggleDecision(null, "unsure")).toBe("unsure");
    expect(isClear(reviewRecord(answer({ decision: "want" }), { decision: null }))).toBe(true);
    expect(isClear(reviewRecord(answer({ decision: "want", note: "keep" }), { decision: null }))).toBe(false);
  });
});

describe("the overlay", () => {
  const bundle: Record<string, Review> = {
    p1: answer({ decision: "no", at: "2026-10-19T01:00:00Z", origin: "import", deck: "Alpha", card: "One" }),
    p2: answer({ decision: "want", at: "2026-10-19T05:00:00Z", origin: "import" }),
  };

  it("shows a tap made after the bundle's answer, and keeps a newer bundle answer over an older tap", () => {
    const ops: LocalOp[] = [
      { op: op({ op_id: "x", swap_key: "p1", at: "2026-10-19T02:00:00Z", decision: "want", note: "on reflection" }), local: "pending" },
      { op: op({ op_id: "y", swap_key: "p2", at: "2026-10-19T03:00:00Z", decision: "no" }), local: "pending" },
      { op: op({ op_id: "z", swap_key: "p3", at: "2026-10-19T03:00:00Z", decision: "unsure" }), local: "sent", seq: 41 },
    ];
    const out = overlayReviews(bundle, ops);
    expect(out.p1).toMatchObject({ decision: "want", note: "on reflection", origin: "yama", local: "pending", deck: "Alpha", card: "One" });
    expect(out.p2).toBe(bundle.p2);
    expect(out.p3).toMatchObject({ decision: "unsure", local: "sent", seq: 41 });
    expect(bundle.p1!.decision).toBe("no"); // the bundle itself is untouched
  });

  it("a cleared tap hides the answer until the bundle catches up", () => {
    const ops: LocalOp[] = [{ op: op({ op_id: "c", swap_key: "p2", at: "2026-10-19T06:00:00Z", decision: null }), local: "pending" }];
    const { answers } = answerIndex(overlayReviews(bundle, ops), {}, ["p1", "p2"]);
    expect(answers.has("p2")).toBe(false);
    expect(answers.get("p1")?.decision).toBe("no");
  });

  it("lays installed ticks and bought marks over the bundle's", () => {
    const marks = { k: { installed: { value: true, at: "2026-10-19T05:00:00Z", payload: {}, op_id: "m" } } };
    const out = overlayMarks(marks, [
      { op: { kind: "installed", op_id: "old", at: "2026-10-19T04:00:00Z", swap_key: "k", deck_key: null, value: false }, local: "pending" },
      { op: { kind: "bought", op_id: "b", at: "2026-10-19T06:00:00Z", swap_key: "k", deck_key: null, value: true, store_key: "shop", store_label: null, price_paid: null, qty: 1, on: "2026-10-19" }, local: "pending" },
    ]);
    expect(out.k!.installed!.value).toBe(true);
    expect(out.k!.bought).toMatchObject({ value: true, local: "pending", payload: { store_key: "shop", price_paid: null, qty: 1 } });
    expect(marks.k.installed.value).toBe(true);
  });
});

describe("reviewItems", () => {
  const stores: Store[] = [{ key: "shop", name: "Example Games", short: "Example", kind: "local", cart_url_template: null, homepage: null, location: null, note: null, print_tiers: null, sort: 1, origin: "import", retired: false, retired_at: null }];
  const quote = (over: Partial<Quote>): Quote => ({
    swap: "p-buy", card: "Buy Me", kind: "stock_check", store: "shop", store_label: null, checked: "2026-10-18", result: "In stock: TST #3 $0.75",
    in_stock: true, price: 0.75, price_from_text: true, currency: "USD", printing: null, set: null, num: null, printing_from_text: false,
    scryfall_id: null, variant: null, url: null, source: "Store website", origin: "import", ...over,
  });
  const swaps = [
    swap({ key: "now", in: "Bought", out: "A", sort: 2 }),
    swap({ key: "print", in: "Printed", out: "B", src: "print", sort: 1 }),
    swap({ key: "later", in: "Moved", out: "C", src: "owned", after_print: true, sort: 3 }),
    swap({ key: "stand", in: "Stand", out: "B", role: "standin", parent: "print" }),
    swap({ key: "opt", in: "Extra", role: "optional" }),
    swap({ key: "p-buy", in: "Buy Me", out: "D", stage: "proposed", why: "Cheap removal", sort: 5 }),
    swap({ key: "p-own", in: "Spare", stage: "proposed", note: "from the binder", sort: 4 }),
    swap({ key: "gone", in: "Gone", retired: true, retired_at: "2026-10-18T00:00:00Z" }),
    swap({ key: "b1", in: "Beta card", deck: "beta" }),
    swap({ key: "z1", in: "Archived card", deck: "zeta" }),
  ];
  const quotes = [quote({ checked: "2026-10-01", result: "Out of stock", in_stock: false }), quote({}), quote({ kind: "market_benchmark", store: null, checked: "2026-10-10", printing: "Test Set (TST) #3", result: null })];
  const answers = new Map<string, Review>([["p-buy", answer({ decision: "want", note: "for the gift card" })], ["now", answer({ decision: "no" })]]);
  const decks = reviewItems({ decks: [deck("beta", 2), deck("alpha", 1), deck("zeta", 3, "archived")], swaps, quotes, stores }, answers);

  it("lists live swaps per deck in plan order, proposals first, then the plan's groups", () => {
    expect(decks.map((d) => d.deck.key)).toEqual(["alpha", "beta"]);
    const alpha = decks[0]!;
    expect(alpha.items.map((i) => [i.group, i.swap.key])).toEqual([
      ["proposed", "p-own"], ["proposed", "p-buy"], ["now", "now"], ["standins", "stand"], ["prints", "print"], ["prints", "later"], ["optional", "opt"],
    ]);
    expect(alpha.items.find((i) => i.swap.key === "p-buy")!.quotes.map((q) => q.checked)).toEqual(["2026-10-18", "2026-10-10", "2026-10-01"]);
  });

  it("counts for the chips and filters", () => {
    const alpha = decks[0]!;
    expect(alpha.counts).toEqual({ all: 7, undecided: 5, proposed: 2, want: 1, unsure: 0, no: 1 });
    expect(filterItems(alpha.items, "undecided", "").map((i) => i.swap.key)).toEqual(["p-own", "stand", "print", "later", "opt"]);
    expect(filterItems(alpha.items, "no", "").map((i) => i.swap.key)).toEqual(["now"]);
  });

  it("searches reasons, store names, stock notes and your notes", () => {
    const alpha = decks[0]!;
    expect(filterItems(alpha.items, "all", "example games").map((i) => i.swap.key)).toEqual(["p-buy"]);
    expect(filterItems(alpha.items, "all", "removal cheap").map((i) => i.swap.key)).toEqual(["p-buy"]);
    expect(filterItems(alpha.items, "all", "gift").map((i) => i.swap.key)).toEqual(["p-buy"]);
    expect(filterItems(alpha.items, "all", "binder").map((i) => i.swap.key)).toEqual(["p-own"]);
    expect(filterItems(alpha.items, "all", "nothing like this")).toEqual([]);
  });
});

describe("answerState", () => {
  const opts = { source: "import" as const, pulledThrough: 10, app: "commander-decks" };
  it("says where an answer is on its way", () => {
    expect(answerState(undefined, opts)).toBeNull();
    expect(answerState(answer({ local: "pending" }), opts)?.label).toBe("Saved on this phone, waiting to sync");
    expect(answerState(answer({ local: "sent", seq: 11 }), opts)?.label).toBe("Saved in Yama, waiting for commander-decks to pick it up");
    expect(answerState(answer({ seq: 10 }), opts)?.label).toBe("Picked up by commander-decks");
    expect(answerState(answer({ origin: "import" }), opts)?.label).toBe("From commander-decks");
    expect(answerState(answer({ seq: 99 }), { ...opts, source: "yama" })?.label).toBe("Saved");
  });
});
