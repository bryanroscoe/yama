// A synthetic plan; Bryan's own data stays out of this repo.
import { describe, expect, it } from "vitest";
import {
  answerIndex,
  applyBag,
  boughtText,
  bracketBuilds,
  deckChanges,
  deckCounts,
  deckDiff,
  deckLogs,
  exportText,
  fmtDate,
  gameChangersIn,
  gotText,
  ownedOrStockedLocally,
  printText,
  proposalBuild,
  slotSource,
  sourceContext,
  swapSource,
  swapStatus,
  usd,
  type Order,
  type PlanDeck,
  type Quote,
  type Review,
  type Slot,
  type Store,
  type Swap,
} from "./index";

const s = (name: string, qty = 1, extra: Partial<Slot> = {}): Slot => ({ name, qty, board: "main", kind: "stock", ...extra });
const commander: Slot = { name: "Test Commander", qty: 1, board: "commander", kind: "stock", set: "tst", num: "1" };

const stock: Slot[] = [commander, s("Zap"), s("old card"), s("Cut Card"), s("Forest", 30, { set: "tst", num: "290" }), s("Forest", 20, { set: "abc", num: "7" }), s("Éclair"), s("Island", 45)];
const after: Slot[] = [
  commander,
  s("Zap"),
  s("Print Card", 1, { kind: "print", replaces: "old card", print_order: "proxy-1", swap: "plan|Alpha|Print Card|old card" }),
  s("Bought Card", 1, { kind: "bought", set: "new", num: "12", order_item: { order: "shop-1", line: 1 }, replaces: "Cut Card" }),
  s("Forest", 30, { set: "tst", num: "290" }),
  s("Forest", 20, { set: "abc", num: "7" }),
  s("Éclair"),
  s("Island", 45),
];

const stores: Store[] = [
  { key: "shop", name: "Example Games", short: "Example", kind: "local", cart_url_template: null, homepage: null, location: null, note: null, print_tiers: null, sort: 1, origin: "import", retired: false, retired_at: null },
  { key: "far", name: "Far Away Cards", short: null, kind: "online", cart_url_template: null, homepage: null, location: null, note: null, print_tiers: null, sort: 2, origin: "import", retired: false, retired_at: null },
  { key: "printer", name: "Example Printer", short: "EP", kind: "printer", cart_url_template: null, homepage: null, location: null, note: null, print_tiers: [18], sort: 3, origin: "import", retired: false, retired_at: null },
];

const order = (o: Partial<Order> & Pick<Order, "key" | "kind" | "vendor">): Order => ({
  status: "received", store: null, order_number: null, date_ordered: null, placed_by: null, date_fulfilled: null, fulfillment: null,
  currency: "USD", subtotal: null, subtotal_note: null, shipping: null, tax: null, total: null, card_stock: null, evidence: null,
  issues: [], note: null, origin: "import", retired: false, retired_at: null, items: [], ...o,
});

const item = (line: number, card: string, unit_price: number | null) => ({
  line, card, qty: 1, listing: null, set: null, num: null, finish: null, scryfall_id: null, received: null, arrived: true,
  deck: "alpha", replaces: null, role: "plan card", unit_price,
});

const orders: Order[] = [
  order({ key: "shop-1", kind: "real", vendor: "Example Games Inc", store: "shop", date_ordered: "2026-10-08", items: [item(1, "Bought Card", 0.5), item(2, "Stand Card", null)] }),
  order({ key: "proxy-1", kind: "proxy", status: "placed", vendor: "Example Printer", store: "printer", placed_by: "2026-10-15", items: [item(1, "Print Card", 0.3)] }),
];

const deck = (over: Partial<PlanDeck> = {}): PlanDeck => ({
  key: "alpha", name: "Alpha", source: "import", status: "active", product: null, commander: ["Test Commander"], color_identity: "G",
  owner_changes: [{ out: "Zap", in: "Zap", note: "The owner's change before the plans" }], bracket: null, groups: [], notes: [],
  deck_id: null, sort: 1, updated_at: "2026-10-19T00:00:00Z", states: {}, ...over,
});

const swap = (over: Partial<Swap> & Pick<Swap, "key" | "in">): Swap => ({
  deck: "alpha", stage: "planned", role: "swap", parent: null, src: "buy", src_declared: null, store_label: null, out: null,
  plan_card: null, later_out: null, after_print: false, tier: null, band: null, group: null, sort: 0, game_changer: null, got: null,
  order_item: null, print_order: null, listing: null, when: null, advice: null, why: null, why_out: null, note: null, upgrade: null,
  retired: false, retired_at: null, updated_at: "2026-10-19T00:00:00Z", ...over,
});

const ctx = sourceContext({ orders, stores, decks: [deck(), deck({ key: "beta", name: "Beta Deck" })] });

describe("copy text", () => {
  it("names only: commander first, basics last and summed, A to Z by lower-cased name", () => {
    expect(exportText(stock)).toBe(
      ["Commander", "1 Test Commander", "", "Deck", "1 Cut Card", "1 old card", "1 Zap", "1 Éclair", "50 Forest", "45 Island", ""].join("\n"),
    );
  });

  it("with printings: one line per printing, set codes in capitals", () => {
    expect(exportText(after, { printings: true })).toBe(
      [
        "Commander", "1 Test Commander (TST) 1", "", "Deck",
        "1 Bought Card (NEW) 12", "1 Print Card", "1 Zap", "1 Éclair",
        "20 Forest (ABC) 7", "30 Forest (TST) 290", "45 Island", "",
      ].join("\n"),
    );
  });

  it("diffs two lists by name, ignoring printings", () => {
    const d = deckDiff(stock, after);
    expect(d.added).toEqual([
      { name: "Bought Card", board: "main", qty: 1 },
      { name: "Print Card", board: "main", qty: 1 },
    ]);
    expect(d.removed).toEqual([
      { name: "Cut Card", board: "main", qty: 1 },
      { name: "old card", board: "main", qty: 1 },
    ]);
    expect(deckDiff([s("Island", 40)], [s("Island", 38), s("Sol Ring")])).toEqual({
      added: [{ name: "Sol Ring", board: "main", qty: 1 }],
      removed: [{ name: "Island", board: "main", qty: 2 }],
    });
  });
});

describe("where it came from", () => {
  it("ports got_text's sentences", () => {
    expect(gotText({ how: "bought", order: "shop-1" }, ctx)).toBe("Bought at Example, ordered 8 Oct 2026.");
    expect(gotText({ how: "pulled", product: "a Bloomburrow collector booster", date: "2026-10-01" }, ctx)).toBe(
      "Pulled from a Bloomburrow collector booster (1 Oct 2026).",
    );
    expect(gotText({ how: "pulled", product: "a prerelease pack" }, ctx)).toBe("Pulled from a prerelease pack.");
    expect(gotText({ how: "deck", deck: "beta", deck_name: "Beta Deck", origin: "precon" }, ctx)).toBe("From Beta Deck (came in that precon).");
    expect(gotText({ how: "deck", deck: "beta", origin: "shop-1" }, ctx)).toBe("From Beta Deck (bought at Example, ordered 8 Oct 2026 for that deck).");
    // A deck outside the plan keeps its own name.
    expect(gotText({ how: "deck", deck: null, deck_name: "Old Deck", origin: "precon" }, ctx)).toBe("From Old Deck (came in that precon).");
  });

  it("names the order, its date and the price paid, and never turns a missing price into $0", () => {
    expect(boughtText({ order: "shop-1", line: 1 }, ctx)).toBe("Bought at Example, ordered 8 Oct 2026, $0.50.");
    expect(boughtText({ order: "shop-1", line: 2 }, ctx)).toBe("Bought at Example, ordered 8 Oct 2026, price not recorded.");
    expect(printText("proxy-1", ctx)).toBe("Print, on the Example Printer order placed by 15 Oct 2026.");
    expect(printText(null, ctx)).toBe("Print, for the next print order.");
    expect(usd(null)).toBe("no price");
    expect(usd(0)).toBe("$0.00");
    expect(fmtDate("2026-10-08")).toBe("8 Oct 2026");
    expect(fmtDate(null)).toBe("");
  });

  it("leaves out stores, dates and prices for a shared view", () => {
    const shared = { private: false };
    expect(gotText({ how: "deck", deck: "beta", origin: "shop-1" }, ctx, shared)).toBe("From Beta Deck (bought for that deck).");
    expect(boughtText({ order: "shop-1", line: 1 }, ctx, shared)).toBe("Bought.");
    expect(printText("proxy-1", ctx, shared)).toBe("Print, on order.");
    const slot = s("Bought Card", 1, { kind: "bought", order_item: { order: "shop-1", line: 1 }, source: "Bought at Example, $0.50" });
    for (const text of [slotSource(slot, ctx, undefined, shared), slotSource({ ...slot, kind: undefined }, ctx, undefined, shared)]) {
      expect(text).not.toMatch(/\$|Example|Oct/);
    }
  });

  it("describes swaps and slots from their structured fields", () => {
    expect(swapSource(swap({ key: "k1", in: "Bought Card", order_item: { order: "shop-1", line: 1 } }), ctx)).toBe("Bought at Example, ordered 8 Oct 2026, $0.50.");
    expect(swapSource(swap({ key: "k2", in: "X", store_label: "Example" }), ctx)).toBe("Not bought yet (planned at Example).");
    expect(swapSource(swap({ key: "k3", in: "X", stage: "proposed" }), ctx)).toBe("To buy.");
    expect(swapSource(swap({ key: "k4", in: "Print Card", src: "print", print_order: "proxy-1" }), ctx)).toBe("Print, on the Example Printer order placed by 15 Oct 2026.");
    expect(slotSource(s("Zap", 1, { kind: "owner" }), ctx, deck())).toBe("The owner's change before the plans.");
    expect(slotSource(s("Island", 1, { kind: "fill" }), ctx)).toBe("Basic land for now, until the print arrives.");
    expect(slotSource(s("Moved Card", 1, { kind: "moved", from_deck: "beta" }), ctx)).toBe("From Beta Deck.");
  });
});

describe("bracket builds", () => {
  const bracket = {
    target: 4,
    bags: {
      "2": [{ out: "Print Card", in: "old card", from: "Came in this precon" }],
      "3": [
        { out: "Bought Card", in: "Island", from: "Basic land" },
        { out: "Missing Card", in: "Cut Card", from: "Came in this precon" },
      ],
    },
  };

  it("applies bags to the after list, highest bracket first and cumulative, keeping basic counts", () => {
    const [full, b3, b2] = bracketBuilds(after, bracket);
    expect(full!.bracket).toBe(4);
    expect(full!.cards).toBe(after);
    expect(b3!.bracket).toBe(3);
    expect(b3!.cards.find((c) => c.name === "Island")!.qty).toBe(46);
    expect(b3!.cards.filter((c) => c.name === "Forest").map((c) => c.qty)).toEqual([30, 20]);
    expect(b3!.cards.some((c) => c.name === "Bought Card")).toBe(false);
    expect(b3!.cards.reduce((n, c) => n + c.qty, 0)).toBe(100);
    // Bracket 2 builds on Bracket 3.
    expect(b2!.cards.some((c) => c.name === "Island" && c.qty === 46)).toBe(true);
    expect(b2!.cards.find((c) => c.name === "old card")).toMatchObject({ kind: "bracket", replaces: "Print Card", source: "Came in this precon" });
    expect(b2!.cards.reduce((n, c) => n + c.qty, 0)).toBe(100);
    // The input list isn't changed.
    expect(after.find((c) => c.name === "Island")!.qty).toBe(45);
  });

  it("warns when a bag's out isn't in the list, and skips that swap", () => {
    const b3 = bracketBuilds(after, bracket)[1]!;
    expect(b3.warnings).toEqual(["Bracket 3: Missing Card isn't in the list, so Cut Card wasn't swapped in."]);
    expect(b3.cards.some((c) => c.name === "Cut Card")).toBe(false);
    expect(applyBag(after, [{ out: "Zap", in: "Éclair" }], "Bracket 3").warnings).toEqual(["Bracket 3: Éclair is already in the list, so Zap stays."]);
  });

  it("with no bags there is only the full build", () => {
    expect(bracketBuilds(after, null).map((b) => b.bracket)).toEqual([4]);
  });

  it("counts Game Changers", () => {
    expect(gameChangersIn(after, ["Zap", "Print Card", "Not There"])).toEqual(["Print Card", "Zap"]);
  });
});

const review = (decision: Review["decision"], at: string, over: Partial<Review> = {}): Review => ({
  decision, note: null, cut: null, deck: "Alpha", card: null, at, origin: "import", ...over,
});

describe("answers and the proposed build", () => {
  const groups = [
    { label: "Core", bracket: null },
    { label: "Bracket 3 additions", bracket: 3 },
    { label: "Bracket 4 additions", bracket: 4 },
  ];
  const proposals = [
    swap({ key: "p-chosen", in: "Chosen Card", stage: "proposed", out: "Zap", group: "Core", sort: 1 }),
    swap({ key: "p-later", in: "Later Card", stage: "proposed", out: "old card", later_out: "Éclair", group: "Core", sort: 2 }),
    swap({ key: "p-no", in: "Refused Card", stage: "proposed", out: "Zap", group: "Core", sort: 3 }),
    swap({ key: "p-nocut", in: "Homeless Card", stage: "proposed", out: null, sort: 4 }),
    swap({ key: "p-b3", in: "Rhystic Thing", stage: "proposed", out: "Bought Card", group: "Bracket 3 additions", sort: 5, src: "print" }),
    swap({ key: "p-b4", in: "Fast Mana", stage: "proposed", out: "Print Card", group: "Bracket 4 additions", sort: 6, src: "print" }),
  ];
  const reviews = {
    "p-chosen": review("want", "2026-10-19T01:00:00Z", { cut: "Bought Card" }),
    "old-no-key": review("no", "2026-10-19T02:00:00Z"),
  };
  const aliases = { "old-no-key": "p-no" };
  const { answers } = answerIndex(reviews, aliases, proposals.map((p) => p.key));

  it("uses the chosen cut, then the suggested one, then the later one, and leaves out a no", () => {
    const b = proposalBuild(after, proposals, answers, groups, { throughGroup: "Core" });
    expect(b.added).toEqual([
      { key: "p-chosen", in: "Chosen Card", cut: "Bought Card" },
      { key: "p-later", in: "Later Card", cut: "Éclair" },
    ]);
    expect(b.notes).toEqual(["Chosen Card in for Bought Card", "Later Card in for Éclair", "Left out Refused Card (you said no)", "Left out Homeless Card (no cut in the deck)"]);
    expect(b.cards.reduce((n, c) => n + c.qty, 0)).toBe(100);
    expect(b.cards.find((c) => c.name === "Chosen Card")).toMatchObject({ kind: "proposed", replaces: "Bought Card", swap: "p-chosen" });
  });

  it("builds groups cumulatively", () => {
    const b3 = proposalBuild(after, proposals, answers, groups, { throughGroup: "Bracket 3 additions" });
    // Bracket 3's suggested cut was already taken by the chosen cut above, and it has no later cut.
    expect(b3.notes).toContain("Left out Rhystic Thing (no cut in the deck)");
    expect(b3.notes.some((n) => n.includes("Fast Mana"))).toBe(false);
    const all = proposalBuild(after, proposals, answers, groups);
    expect(all.added.map((a) => a.in)).toEqual(["Chosen Card", "Later Card", "Fast Mana"]);
  });

  it("can keep only cards owned or stocked at a local store", () => {
    const quotes: Quote[] = [
      { swap: "p-later", card: "Later Card", kind: "stock_check", store: "shop", store_label: null, checked: "2026-10-18", result: "In stock", in_stock: true, price: 1, price_from_text: false, currency: "USD", printing: null, set: null, num: null, printing_from_text: false, scryfall_id: null, variant: "1", url: null, source: "Store website", origin: "import" },
      { swap: "p-chosen", card: "Chosen Card", kind: "stock_check", store: "far", store_label: null, checked: "2026-10-18", result: "In stock", in_stock: true, price: 1, price_from_text: false, currency: "USD", printing: null, set: null, num: null, printing_from_text: false, scryfall_id: null, variant: "2", url: null, source: "Store website", origin: "import" },
    ];
    const b = proposalBuild(after, proposals, answers, groups, { only: ownedOrStockedLocally(quotes, stores) });
    expect(b.added.map((a) => a.in)).toEqual(["Later Card"]);
  });

  it("follows aliases, lets a newer tombstone clear an answer, and keeps orphans", () => {
    const r = answerIndex(
      {
        "p-chosen": review("want", "2026-10-19T01:00:00Z"),
        "renamed-chosen": review(null, "2026-10-19T03:00:00Z", { note: "" }),
        "p-later": review("unsure", "2026-10-19T01:00:00Z"),
        gone: review("want", "2026-10-19T01:00:00Z"),
        "gone-cleared": review(null, "2026-10-19T01:00:00Z"),
      },
      { "renamed-chosen": "p-chosen" },
      ["p-chosen", "p-later"],
    );
    expect(r.answers.has("p-chosen")).toBe(false);
    expect(r.answers.get("p-later")?.decision).toBe("unsure");
    expect(r.orphans.map(([k]) => k)).toEqual(["gone"]);
  });
});

describe("changes and status", () => {
  const swaps = [
    swap({ key: "plan|Alpha|Bought Card|Cut Card", in: "Bought Card", out: "Cut Card", order_item: { order: "shop-1", line: 1 }, sort: 2 }),
    swap({ key: "plan|Alpha|Print Card|old card", in: "Print Card", out: "old card", src: "print", print_order: "proxy-1", sort: 1 }),
    swap({ key: "standin|Alpha|Stand Card", in: "Stand Card", out: "old card", role: "standin", parent: "plan|Alpha|Print Card|old card" }),
    swap({ key: "plan|Alpha|Moved Card|Zap", in: "Moved Card", out: "Zap", src: "owned", got: { how: "deck", deck: "beta", deck_name: "Beta Deck", origin: "precon" }, sort: 3 }),
    swap({ key: "opt|Alpha|Extra", in: "Extra", role: "optional" }),
    swap({ key: "idea", in: "Idea Card", stage: "proposed", group: "Core" }),
    swap({ key: "loose-idea", in: "Loose Card", stage: "proposed" }),
    swap({ key: "retired", in: "Gone Card", retired: true, retired_at: "2026-10-19T00:00:00Z" }),
  ];
  const d = deck({
    groups: [{ label: "Core", bracket: null }],
    states: {
      now: {
        id: "n", content_hash: "h", computed_by: "test", updated_at: "", unresolved: [],
        cards: [...after.filter((c) => c.name !== "Print Card"), s("Stand Card", 1, { kind: "standin" })],
        log: [
          { swap: "plan|Alpha|Bought Card|Cut Card", status: "done" },
          { swap: "plan|Alpha|Print Card|old card", status: "standin" },
          { swap: "plan|Alpha|Moved Card|Zap", status: "waiting-move" },
          { swap: "opt|Alpha|Extra", status: "spare" },
        ],
      },
    },
  });

  it("groups live swaps, with stand-ins under their print", () => {
    const c = deckChanges("alpha", d.groups, swaps);
    expect(c.now.map((x) => x.in)).toEqual(["Bought Card", "Moved Card"]);
    expect(c.prints.map((x) => x.in)).toEqual(["Print Card"]);
    expect(c.standins.get("plan|Alpha|Print Card|old card")!.map((x) => x.in)).toEqual(["Stand Card"]);
    expect(c.optional.map((x) => x.in)).toEqual(["Extra"]);
    expect(c.proposed.map((g) => [g.group?.label ?? null, g.swaps.map((x) => x.in)])).toEqual([
      [null, ["Loose Card"]],
      ["Core", ["Idea Card"]],
    ]);
  });

  it("reads each swap's status from the logs", () => {
    const logs = deckLogs(d);
    const name = (k: string | null | undefined) => (k === "beta" ? "Beta Deck" : String(k));
    const status = (key: string) => swapStatus(swaps.find((x) => x.key === key)!, logs, name)?.label;
    expect(status("plan|Alpha|Bought Card|Cut Card")).toBe("In hand");
    expect(status("plan|Alpha|Print Card|old card")).toBe("Stand-in now, print on order");
    expect(status("standin|Alpha|Stand Card")).toBe("In the deck until the print arrives");
    expect(status("plan|Alpha|Moved Card|Zap")).toBe("Waiting for Beta Deck to free it");
    expect(status("opt|Alpha|Extra")).toBe("Spare, not in the list");
    expect(status("idea")).toBeUndefined();
  });

  it("counts what the overview shows", () => {
    const answers = new Map([["idea", review("want", "2026-10-19T01:00:00Z")]]);
    expect(deckCounts(d, swaps, answers)).toEqual({
      planned: 3, ready: 1, standins: 1, printsOnOrder: 1, printsNext: 0, waitingMoves: 1, proposals: 2, undecided: 1,
    });
  });
});
