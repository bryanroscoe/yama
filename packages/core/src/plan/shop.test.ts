// Buy list, price flags, print plan, spares and overview counts, on a synthetic plan (Bryan's own
// data stays out of this repo; real-plan.test.ts compares with it locally).
import { describe, expect, it } from "vitest";
import {
  answerIndex,
  backFace,
  buyList,
  cartUrl,
  deckCounts,
  inHand,
  installedState,
  deckLogs,
  isStale,
  laterOutText,
  markIndex,
  orderText,
  overviewCounts,
  ownedOrStockedLocally,
  pickTier,
  priceFlag,
  printPlan,
  rulesAt,
  spares,
  specialVersion,
  swapStatus,
  usd,
  type Mark,
  type Order,
  type PlanBundle,
  type PlanDeck,
  type PlanState,
  type Quote,
  type Review,
  type RuleSet,
  type Slot,
  type Store,
  type Swap,
} from "./index";

// ── fixture ────────────────────────────────────────────────────────────────

const slot = (name: string, extra: Partial<Slot> = {}): Slot => ({ name, qty: 1, board: "main", kind: "stock", ...extra });
const cmdr = (name: string): Slot => ({ name, qty: 1, board: "commander", kind: "stock" });
const state = (cards: Slot[], log: PlanState["log"] = []): PlanState => ({ id: "", content_hash: "", computed_by: "", updated_at: "", cards, log, unresolved: [] });

const swap = (over: Partial<Swap> & Pick<Swap, "key" | "in" | "deck">): Swap => ({
  stage: "planned", role: "swap", parent: null, src: "buy", src_declared: null, store_label: null, out: null, plan_card: null,
  later_out: null, after_print: false, tier: null, band: null, group: null, sort: 0, game_changer: null, got: null, order_item: null,
  print_order: null, listing: null, when: null, advice: null, why: null, why_out: null, note: null, upgrade: null, retired: false,
  retired_at: null, updated_at: "", ...over,
});

const store = (over: Partial<Store> & Pick<Store, "key" | "name" | "kind">): Store => ({
  short: null, cart_url_template: null, homepage: null, location: null, note: null, print_tiers: null, sort: 0, origin: "import",
  retired: false, retired_at: null, ...over,
});

const quote = (over: Partial<Quote> & Pick<Quote, "swap" | "card">): Quote => ({
  kind: "stock_check", store: null, store_label: null, checked: "2026-10-18", result: null, in_stock: true, price: null,
  price_from_text: false, currency: "USD", printing: null, set: null, num: null, printing_from_text: false, scryfall_id: null,
  variant: null, url: null, source: "Store website", origin: "import", ...over,
});

const order = (o: Partial<Order> & Pick<Order, "key" | "kind" | "vendor">): Order => ({
  status: "received", store: null, order_number: null, date_ordered: null, placed_by: null, date_fulfilled: null, fulfillment: null,
  currency: "USD", subtotal: null, subtotal_note: null, shipping: null, tax: null, total: null, card_stock: null, evidence: null,
  issues: [], note: null, origin: "import", retired: false, retired_at: null, items: [], ...o,
});

const settings: RuleSet[] = [
  { effective_from: "2026-10-08", note: "first", origin: "import", rules: { max_over_market_pct: 25, avoid_pricey_printing: true, always_print_over_usd: 10, shiny_only_if_no_plain: true, buy_local_only: true, proxy_cost_usd: 0.3, proxy_cost_note: "at least $0.30" } },
  { effective_from: "2026-10-10", note: "second", origin: "import", rules: { max_over_market_pct: 25, avoid_pricey_printing: true, always_print_over_usd: 10, shiny_only_if_no_plain: true, buy_local_only: true, ceiling_key_usd: 4, ceiling_other_usd: 3, ceiling_other_note: "about $2–3", proxy_cost_usd: 0.3, proxy_cost_note: "at least $0.30" } },
];

const stores: Store[] = [
  store({ key: "shop", name: "Example Games", short: "Example", kind: "local", cart_url_template: "https://shop.example/cart/{items}", sort: 1 }),
  store({ key: "mother", name: "Mother Games", short: "Mother", kind: "local", cart_url_template: "https://mother.example/cart/{items}", sort: 2 }),
  store({ key: "far", name: "Far Cards", kind: "online", cart_url_template: "https://far.example/cart/{items}", sort: 3 }),
  store({ key: "gurus", name: "Gurus", kind: "local", sort: 4 }),
  store({ key: "printer", name: "Example Printer", kind: "printer", print_tiers: [18, 36, 162, 180], sort: 5 }),
];

// Alpha: a buy, a print held by a stand-in, a print whose old card can't stay (a basic fills the slot),
// and a print that frees Guide for Beta. Your own change put Off Color in for Stock Land.
const alpha: PlanDeck = {
  key: "alpha", name: "Alpha", source: "import", status: "active", product: null, commander: ["Cmdr A"], color_identity: "G",
  owner_changes: [{ out: "Stock Land", in: "Off Color", note: "Your change" }], bracket: null, groups: [], notes: [], deck_id: null, sort: 1, updated_at: "",
  states: {
    stock: state([cmdr("Cmdr A"), slot("Stock Land"), slot("Old A"), slot("Old B"), slot("Guide"), slot("Forest", { qty: 5 })]),
    now: state(
      [
        cmdr("Cmdr A"), slot("Island", { kind: "fill", replaces: "Off Color", swap: "plan|Alpha|Volcano|Off Color" }),
        slot("New A", { kind: "bought", replaces: "Old A", swap: "plan|Alpha|New A|Old A", order_item: { order: "shop-1", line: 1 } }),
        slot("Stand B", { kind: "standin", replaces: "Old B", swap: "standin|Alpha|Stand B", order_item: { order: "shop-1", line: 2 } }),
        slot("Guide"), slot("Forest", { qty: 5 }),
      ],
      [
        { swap: "plan|Alpha|New A|Old A", status: "done" },
        { swap: "plan|Alpha|Print B|Old B", status: "standin" },
        { swap: "plan|Alpha|Volcano|Off Color", status: "fill" },
        { swap: "plan|Alpha|Ark|Guide", status: "waiting" },
      ],
    ),
    after: state(
      [
        cmdr("Cmdr A"), slot("Volcano", { kind: "print", replaces: "Off Color", print_order: "proxy-1" }),
        slot("New A", { kind: "bought", replaces: "Old A" }), slot("Print B", { kind: "print", replaces: "Old B", print_order: "proxy-1" }),
        slot("Ark", { kind: "print", replaces: "Guide", print_order: "proxy-1" }), slot("Forest", { qty: 4 }),
        slot("Fable of the Mirror-Breaker", { kind: "print", replaces: "Forest", print_order: "proxy-1" }),
      ],
      [{ swap: "plan|Alpha|Print B|Old B", status: "print" }],
    ),
  },
};

// Beta: Guide moves in from Alpha once Alpha's print arrives, so Primordial stays until then.
const beta: PlanDeck = {
  ...alpha, key: "beta", name: "Beta", owner_changes: [], sort: 2,
  states: {
    stock: state([cmdr("Cmdr B"), slot("Primordial"), slot("Junk"), slot("Junk 2")]),
    now: state([cmdr("Cmdr B"), slot("Primordial"), slot("Junk"), slot("Junk 2")], [{ swap: "plan|Beta|Guide|Primordial", status: "waiting-move" }]),
    after: state(
      [cmdr("Cmdr B"), slot("Guide", { kind: "moved", replaces: "Primordial", from_deck: "alpha", swap: "plan|Beta|Guide|Primordial" }), slot("Junk"), slot("Junk 2")],
      [{ swap: "plan|Beta|Guide|Primordial", status: "moved" }],
    ),
  },
};
const gamma: PlanDeck = { ...beta, key: "gamma", name: "Gamma", status: "proposals_only", sort: 3, states: { stock: beta.states.stock, now: beta.states.stock, after: beta.states.stock } };

const swaps: Swap[] = [
  swap({ key: "plan|Alpha|New A|Old A", deck: "alpha", in: "New A", out: "Old A", order_item: { order: "shop-1", line: 1 } }),
  swap({ key: "plan|Alpha|Print B|Old B", deck: "alpha", in: "Print B", out: "Old B", src: "print", print_order: "proxy-1" }),
  swap({ key: "standin|Alpha|Stand B", deck: "alpha", in: "Stand B", out: "Old B", role: "standin", parent: "plan|Alpha|Print B|Old B", later_out: "New A", order_item: { order: "shop-1", line: 2 } }),
  swap({ key: "plan|Alpha|Volcano|Off Color", deck: "alpha", in: "Volcano", out: "Off Color", src: "print", print_order: "proxy-1" }),
  swap({ key: "plan|Alpha|Ark|Guide", deck: "alpha", in: "Ark", out: "Guide", src: "print", print_order: "proxy-1" }),
  swap({ key: "plan|Alpha|Fable of the Mirror-Breaker|Forest", deck: "alpha", in: "Fable of the Mirror-Breaker", out: "Forest", src: "print", print_order: "proxy-1" }),
  swap({ key: "plan|Beta|Guide|Primordial", deck: "beta", in: "Guide", out: "Primordial", src: "owned", got: { how: "deck", deck: "alpha", origin: "precon" } }),
  swap({ key: "plan|Beta|Pending|Junk", deck: "beta", in: "Pending", out: "Junk", store_label: "Example" }),
  // proposals
  swap({ key: "p-counter", deck: "beta", stage: "proposed", in: "Counter", out: "Junk" }),
  swap({ key: "p-rider", deck: "beta", stage: "proposed", in: "Rider", out: "Junk 2" }),
  swap({ key: "p-nope", deck: "beta", stage: "proposed", in: "Nope", out: "Junk" }),
  swap({ key: "p-unpriced", deck: "beta", stage: "proposed", in: "Unpriced", out: "Junk" }),
  swap({ key: "p-nowhere", deck: "beta", stage: "proposed", in: "Nowhere", out: "Junk" }),
  swap({ key: "p-marked", deck: "beta", stage: "proposed", in: "Marked", out: "Junk" }),
  swap({ key: "p-want-print", deck: "beta", stage: "proposed", src: "print", in: "Want Print", out: "Junk" }),
  swap({ key: "p-maybe-print", deck: "beta", stage: "proposed", src: "print", in: "Maybe Print", out: "Junk" }),
  swap({ key: "p-primordial", deck: "gamma", stage: "proposed", src: "owned", in: "Primordial", out: "Junk", got: { how: "deck", deck: "beta", origin: "precon" } }),
  swap({ key: "p-old-a", deck: "gamma", stage: "proposed", src: "owned", in: "Old A", out: "Junk", got: { how: "deck", deck: "alpha", origin: "precon" } }),
  swap({ key: "p-retired", deck: "beta", stage: "proposed", in: "Gone", retired: true }),
];

const quotes: Quote[] = [
  // Counter: Far Cards is cheaper, but its newest check says sold out; Example has it.
  quote({ swap: "p-counter", card: "Counter", store: "far", variant: "22", price: 1.5, checked: "2026-10-01" }),
  quote({ swap: "p-counter", card: "Counter", store: "far", variant: "22", price: 1.5, checked: "2026-10-18", in_stock: false }),
  quote({ swap: "p-counter", card: "Counter", store: "shop", variant: "11", price: 2.25, result: "In stock: A25 #50 Lightly Played $2.25" }),
  quote({ swap: "p-counter", card: "Counter", store: "mother", variant: "33", price: 2.5 }),
  // Rider: Mother's listing for 2X2 #173, against that printing's market.
  quote({ swap: "p-rider", card: "Rider", store: "mother", variant: "44", price: 0.75, set: "2x2", num: "173", result: "In stock: 2X2 #173 Near Mint $0.75 (2)" }),
  quote({ swap: "p-rider", card: "Rider", kind: "market_benchmark", price: 0.51, printing: "Forgotten Realms Commander (AFC) #175", source: "TCGplayer market via Scryfall, cheapest non-foil", in_stock: null }),
  quote({ swap: "p-nope", card: "Nope", store: "shop", variant: "55", price: 1 }),
  quote({ swap: "p-unpriced", card: "Unpriced", store: "shop", variant: "66", price: null, result: "In stock" }),
  quote({ swap: "p-nowhere", card: "Nowhere", store: "gurus", price: 0.3, result: "In store, $0.30" }),
  quote({ swap: "p-nowhere", card: "Nowhere", store: "shop", in_stock: false, result: "Out of stock" }),
  quote({ swap: "p-marked", card: "Marked", store: "shop", variant: "77", price: 1 }),
];

const orders: Order[] = [
  order({ key: "shop-1", kind: "real", vendor: "Example Games Inc", store: "shop", date_ordered: "2026-10-08" }),
  order({
    key: "proxy-1", kind: "proxy", status: "placed", vendor: "Example Printer", store: "printer", placed_by: "2026-10-15",
    items: ["Ark", "Fable of the Mirror-Breaker", "Print B", "Volcano", "Not In Plan"].map((card, i) => ({
      line: i + 1, card, qty: 1, listing: null, set: null, num: null, finish: null, scryfall_id: null, received: null, arrived: null, deck: null, replaces: null, role: "print", unit_price: null,
    })),
  }),
];

const bundle: PlanBundle = {
  rev: "", revision: 1, head: null, notes: [], game_changers: null, library: null,
  settings: settings as unknown as PlanBundle["settings"], stores, decks: [alpha, beta, gamma], swaps, aliases: { "p-old-marked": "p-marked" }, orders, quotes,
  reviews: {}, marks: {},
  inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] },
  names: { Rider: "o-rider", Counter: "o-counter", "Fable of the Mirror-Breaker": "o-fable" },
  unresolved: [],
  cards: {
    "o-fable": { name: "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", type_line: "", cmc: 3, color_identity: "R", layout: "transform", image_small: null, image_art_crop: null, faces: [{ name: "Fable of the Mirror-Breaker" }, { name: "Reflection of Kiki-Jiki" }] },
  },
  market: {
    "o-rider": { usd: 0.51, printing: "Forgotten Realms Commander (AFC) #175", set: "afc", num: "175", scryfall_id: "s-afc", date: "2026-10-18", source: "TCGplayer market via Scryfall, cheapest non-foil" },
    "o-counter": { usd: 2.15, printing: "Foundations Jumpstart (J25) #61", set: "j25", num: "61", scryfall_id: "s-j25", date: "2026-10-18", source: "TCGplayer market via Scryfall, cheapest non-foil" },
  },
  market_by_printing: { "s-2x2": { usd: 0.53, usd_foil: 1.2, date: "2026-10-18", set: "2x2", num: "173", source: "TCGplayer market via Scryfall" } },
  printing_ids: { "2x2/173": "s-2x2" },
  prices_as_of: "2026-10-18",
};

const review = (decision: Review["decision"], cut: string | null = null): Review => ({ decision, note: null, cut, deck: null, card: null, at: "2026-10-19T00:00:00Z", origin: "yama" });
const reviews: Record<string, Review> = { "p-nope": review("no"), "p-rider": review("unsure", "Junk"), "p-want-print": review("want"), "p-primordial": review(null, null) };
const live = swaps.filter((s) => !s.retired).map((s) => s.key);
const { answers } = answerIndex(reviews, {}, live);
const mark = (value: boolean, at: string, payload: Record<string, unknown> = {}): Mark => ({ value, at, payload, op_id: at, seq: null });

// ── rules ──────────────────────────────────────────────────────────────────

describe("rules and price flags", () => {
  it("picks the rule set in force on a date", () => {
    expect(rulesAt(settings, "2026-10-07")).toBeNull();
    expect(rulesAt(settings, "2026-10-08")?.note).toBe("first");
    expect(rulesAt(settings, "2026-10-09T23:00:00Z")?.note).toBe("first");
    expect(rulesAt(settings, "2026-10-10")?.note).toBe("second");
    expect(rulesAt(settings, null)?.note).toBe("second");
  });

  it("judges a 10-08 purchase by the 10-08 rules, not the later ceilings", () => {
    const early = priceFlag({ card: "Hallowed Fountain", price: 6.75, date: "2026-10-08", compareMarket: false }, bundle, settings);
    expect(early.rules?.note).toBe("first");
    expect(early.flags).toEqual([]);
    const late = priceFlag({ card: "Hallowed Fountain", price: 6.75, date: "2026-10-12", compareMarket: false }, bundle, settings);
    expect(late.flags.map((f) => f.id)).toEqual(["ceiling-key"]);
    const middling = priceFlag({ card: "X", price: 3.5, date: "2026-10-12", compareMarket: false }, bundle, settings);
    expect(middling.flags.map((f) => f.text)).toEqual(["Above about $2–3: fine only if this card really matters (limit $4.00)."]);
    expect(priceFlag({ card: "X", price: 12, date: "2026-10-08", compareMarket: false }, bundle, settings).flags.map((f) => f.id)).toEqual(["print-over"]);
  });

  it("with no market price there's no over-market flag, only a note", () => {
    const c = priceFlag({ card: "Unknown Card", price: 0.5, date: "2026-10-18" }, bundle, settings);
    expect(c.basis).toBeNull();
    expect(c.flags).toEqual([{ id: "no-market", text: "No market price to compare.", tone: "plain" }]);
    expect(priceFlag({ card: "Unknown Card", price: null, date: "2026-10-18" }, bundle, settings).flags.map((f) => f.id)).toEqual(["no-price"]);
  });

  it("flags Ashen Rider at 42% against its own printing, and says the cheapest printing", () => {
    const c = priceFlag({ card: "Rider", price: 0.75, date: "2026-10-18", printing: { set: "2X2", num: "173" } }, bundle, settings);
    expect(c.basis?.kind).toBe("printing");
    expect(c.overPct).toBe(42);
    expect(c.flags.map((f) => f.id)).toEqual(["over-market", "pricey-printing"]);
    expect(c.flags[0]!.text).toBe("42% over the market for that printing ($0.53 for 2X2 #173, 18 Oct 2026); your limit is 25%.");
    expect(c.flags[1]!.text).toBe("A pricier printing: the cheapest copy is $0.51 for Forgotten Realms Commander (AFC) #175, 18 Oct 2026.");
    // Without Yama's price for that printing it falls back to the cheapest copy (47%).
    expect(priceFlag({ card: "Rider", price: 0.75, date: "2026-10-18" }, bundle, settings).overPct).toBe(47);
  });

  it("falls back to the plan's recorded benchmark, and labels an old price as old", () => {
    const recorded = quotes.filter((q) => q.swap === "p-rider");
    const c = priceFlag({ card: "No Yama Price", price: 0.75, date: "2026-10-18", recorded }, bundle, settings);
    expect(c.basis?.kind).toBe("recorded");
    expect(c.flags.map((f) => f.id)).toContain("over-market");
    expect(c.flags[0]!.text).toContain("47% over the recorded market");
    const old = { ...bundle, market: { "o-rider": { ...bundle.market["o-rider"]!, date: "2026-07-01" } } };
    const s = priceFlag({ card: "Rider", price: 0.75, date: "2026-10-18" }, old, settings);
    expect(s.basis?.stale).toBe(true);
    expect(s.flags[0]!.text).toContain("last priced 1 Jul 2026");
    expect(s.flags[0]!.text).toContain("older than the rest of Yama's prices");
    expect(isStale("2026-10-16", "2026-10-18")).toBe(false);
    expect(isStale("2026-10-14", "2026-10-18")).toBe(true);
  });

  it("spots foil and special versions, and judges a foil against the foil price", () => {
    expect(specialVersion("HOB #26 foil $0.50")).toBe("foil");
    expect(specialVersion("TLE #9 borderless Near Mint $3.50")).toBe("borderless");
    expect(specialVersion("Near Mint non-foil $1")).toBeNull();
    const c = priceFlag({ card: "Rider", price: 1, date: "2026-10-18", text: "2X2 #173 foil", printing: { set: "2x2", num: "173" } }, bundle, settings);
    expect(c.basis?.usd).toBe(1.2);
    expect(c.flags.map((f) => f.id)).toEqual(["pricey-printing", "special"]);
    expect(c.flags[1]!.text).toBe(
      "A foil version, while the cheapest non-foil copy is $0.51 for Forgotten Realms Commander (AFC) #175, 18 Oct 2026. Your rule: pay extra for a foil or special version only when there's no plain one.",
    );
    expect(priceFlag({ card: "X", price: 1, date: "2026-10-18", store: stores[2], compareMarket: false }, bundle, settings).flags.map((f) => f.id)).toEqual(["not-local"]);
  });

  // Agent of Treachery at Pat's: TLE #9 borderless for $3.50. Yama's cheapest non-foil copy is that
  // same printing ($3.44); the plain M20 #43 costs more ($6.13), so nothing extra is paid for the frame.
  const agent: PlanBundle = {
    ...bundle,
    names: { "Agent of Treachery": "o-agent" },
    market: { "o-agent": { usd: 3.44, printing: "Avatar: The Last Airbender Eternal (TLE) #9", set: "tle", num: "9", scryfall_id: "s-tle9", date: "2026-10-18", source: "TCGplayer market via Scryfall, cheapest non-foil" } },
    market_by_printing: {
      "s-tle9": { usd: 3.44, usd_foil: 5.4, date: "2026-10-18", set: "tle", num: "9", source: "TCGplayer market via Scryfall" },
      "s-m20": { usd: 6.13, usd_foil: 9, date: "2026-10-18", set: "m20", num: "43", source: "TCGplayer market via Scryfall" },
    },
    printing_ids: { "tle/9": "s-tle9", "m20/43": "s-m20" },
  };
  const text = "In stock: TLE #9 borderless Near Mint $3.50 (4)";

  it("never calls the listing's own special printing a plain copy", () => {
    const c = priceFlag({ card: "Agent of Treachery", price: 3.5, date: "2026-10-18", text, printing: { set: "TLE", num: "9" } }, agent, settings);
    expect(c.basis?.kind).toBe("printing");
    expect(c.flags.map((f) => f.id)).not.toContain("special");
    // By Scryfall id too.
    expect(priceFlag({ card: "Agent of Treachery", price: 3.5, date: "2026-10-18", text, printing: { scryfall_id: "s-tle9" } }, agent, settings).flags.map((f) => f.id)).not.toContain("special");
  });

  it("a special printing with a cheaper copy of another printing is flagged, without calling that copy plain", () => {
    const cheaper = { ...agent, market: { "o-agent": { ...agent.market["o-agent"]!, usd: 2.1, printing: "Core Set 2020 (M20) #43", set: "m20", num: "43", scryfall_id: "s-m20" } } };
    const c = priceFlag({ card: "Agent of Treachery", price: 3.5, date: "2026-10-18", text, printing: { set: "tle", num: "9" } }, cheaper, settings);
    const flag = c.flags.find((f) => f.id === "special")!;
    expect(flag.text).toBe(
      "A borderless version, while the cheapest non-foil copy is $2.10 for Core Set 2020 (M20) #43, 18 Oct 2026. Yama can't tell whether that printing is a plain one. Your rule: pay extra for a foil or special version only when there's no plain one.",
    );
    expect(flag.text).not.toMatch(/plain copy/);
  });

  it("a foil listing still counts its own printing's non-foil copy", () => {
    const foil = priceFlag({ card: "Agent of Treachery", price: 5.4, date: "2026-10-18", text: "TLE #9 foil", printing: { set: "tle", num: "9" } }, agent, settings);
    expect(foil.basis?.usd).toBe(5.4);
    expect(foil.flags.find((f) => f.id === "special")?.text).toContain("while the cheapest non-foil copy is $3.44 for Avatar: The Last Airbender Eternal (TLE) #9");
  });
});

// ── buy list ───────────────────────────────────────────────────────────────

describe("buyList", () => {
  const marks = markIndex({ "p-old-marked": { bought: mark(true, "2026-10-19T01:00:00Z", { store_key: "shop", price_paid: 1, qty: 1, on: "2026-10-19" }) } }, bundle.aliases, live).marks;
  const list = buyList(bundle, { answers, marks });
  const where = (card: string) => {
    const g = list.stores.find((g) => g.rows.some((r) => r.swap.in === card));
    if (g) return g.store.key;
    if (list.elsewhere.some((r) => r.swap.in === card)) return "elsewhere";
    if (list.marked.some((r) => r.swap.in === card)) return "marked";
    if (list.declined.some((r) => r.swap.in === card)) return "declined";
    return null;
  };

  it("leaves out no answers, bought plan rows and retired swaps; keeps planned buys with no order", () => {
    expect(where("Nope")).toBe("declined");
    expect(where("New A")).toBeNull();
    expect(where("Gone")).toBeNull();
    expect(where("Pending")).toBe("elsewhere");
    expect(where("Maybe Print")).toBeNull();
  });

  it("uses each store's newest check: a newer sold out beats an older in stock, and the cheapest of the rest wins", () => {
    expect(where("Counter")).toBe("shop");
    const row = list.stores.find((g) => g.store.key === "shop")!.rows.find((r) => r.swap.in === "Counter")!;
    expect(row.price).toBe(2.25);
    expect(row.others.map((q) => q.store).sort()).toEqual(["far", "mother"]);
    expect(where("Nowhere")).toBe("elsewhere");
  });

  it("prefers your cut over the suggested one", () => {
    const rider = list.stores.find((g) => g.store.key === "mother")!.rows[0]!;
    expect(rider.replaces).toBe("Junk");
    expect(rider.yourCut).toBe(true);
    expect(rider.check?.flags.map((f) => f.id)).toContain("over-market");
  });

  it("totals only known prices, keeps unpriced listings out of carts, and builds cart links", () => {
    const shop = list.stores.find((g) => g.store.key === "shop")!;
    // Unpriced is in stock at Example with a variant but no price: not in the cart or its heading.
    expect(shop.rows.map((r) => r.swap.in)).toEqual(["Counter"]);
    expect(shop.total).toBe(2.25);
    expect(shop.cartUrl).toBe("https://shop.example/cart/11:1");
    expect(list.noPrice.map((r) => [r.swap.in, r.store?.key, r.listing?.variant, r.price])).toEqual([["Unpriced", "shop", "66", null]]);
    expect(list.noPrice[0]!.check?.flags.map((f) => f.id)).toEqual(["no-price"]);
    expect(list.total).toBe(3);
    expect(list.priced).toBe(2);
    expect(list.unpriced).toBe(3); // Unpriced, plus Nowhere and Pending with no listing
    expect(list.count).toBe(5);
    expect(cartUrl(stores[0]!, [])).toBeNull();
    expect(cartUrl({ ...stores[0]!, cart_url_template: "http://shop.example/cart/{items}" }, ["1"])).toBeNull();
  });

  it("a priced listing beats a cheaper-looking one with no price", () => {
    const qs = [
      quote({ swap: "p-counter", card: "Counter", store: "shop", variant: "11", price: null, result: "In stock" }),
      quote({ swap: "p-counter", card: "Counter", store: "mother", variant: "33", price: 2.5 }),
    ];
    const l = buyList({ ...bundle, quotes: qs }, { answers });
    const row = l.stores.flatMap((g) => g.rows).find((r) => r.swap.in === "Counter")!;
    expect([row.store?.key, row.price]).toEqual(["mother", 2.5]);
    expect(row.others.map((q) => q.store)).toEqual(["shop"]);
  });

  it("with no listed price anywhere the total is unknown, never $0.00", () => {
    const qs = quotes.filter((q) => q.swap === "p-unpriced" || q.swap === "p-nowhere");
    const l = buyList({ ...bundle, quotes: qs, swaps: swaps.filter((s) => ["p-unpriced", "p-nowhere"].includes(s.key)) }, { answers });
    expect(l.stores).toEqual([]);
    expect(l.total).toBeNull();
    expect(usd(l.total)).toBe("no price");
    expect([l.priced, l.unpriced, l.count]).toEqual([0, 2, 2]);
    const c = overviewCounts({ ...bundle, quotes: qs, swaps: swaps.filter((s) => ["p-unpriced", "p-nowhere"].includes(s.key)) }, { answers, marks: new Map(), today: "2026-10-19" });
    expect(c.buyTotal).toBeNull();
    expect(c.buyUnpriced).toBe(2);
  });

  it("a card marked bought (through an alias) leaves the totals and carts until the plan records an order", () => {
    expect(where("Marked")).toBe("marked");
    expect(list.marked[0]!.bought).toEqual({ store_key: "shop", store_label: null, price_paid: 1, qty: 1, on: "2026-10-19" });
    const cleared = markIndex({ "p-marked": { bought: mark(false, "2026-10-19T02:00:00Z") }, "p-old-marked": { bought: mark(true, "2026-10-19T01:00:00Z", { on: "2026-10-19" }) } }, bundle.aliases, live).marks;
    expect(buyList(bundle, { answers, marks: cleared }).marked).toEqual([]);
  });
});

// ── prints ─────────────────────────────────────────────────────────────────

describe("printPlan", () => {
  const plan = printPlan(bundle, { answers, today: "2026-10-19" });

  it("splits placed prints from the next order, with stand-ins as what leaves", () => {
    expect(plan.placed).toHaveLength(1);
    const placed = plan.placed[0]!;
    expect(placed.lines.map((l) => l.card)).toEqual(["Ark", "Fable of the Mirror-Breaker", "Print B", "Volcano"]);
    expect(placed.lines.find((l) => l.card === "Print B")!.takesOut).toBe("Stand B");
    expect(placed.lines.find((l) => l.card === "Ark")!.takesOut).toBe("Guide");
    expect(placed.extra).toEqual([{ card: "Not In Plan", qty: 1 }]);
    expect(plan.next.lines.map((l) => [l.card, l.proposed])).toEqual([["Want Print", true]]);
    expect(plan.next.estimate).toBe(0.3);
    expect(plan.next.eachNote).toBe("at least $0.30");
    expect(plan.printer?.key).toBe("printer");
  });

  it("picks the smallest recorded tier that fits", () => {
    expect(pickTier(1, [180, 18, 162])).toEqual({ size: 18, free: 17, tiers: [18, 162, 180] });
    expect(pickTier(18, [18, 36])).toEqual({ size: 18, free: 0, tiers: [18, 36] });
    expect(pickTier(200, [162, 180])).toEqual({ size: null, free: null, tiers: [162, 180] });
    expect(pickTier(3, null)).toEqual({ size: null, free: null, tiers: [] });
    expect(plan.next.tier.size).toBe(18);
  });

  it("flags double-faced cards with the back to print", () => {
    expect(plan.doubleFaced.map((l) => [l.card, l.back])).toEqual([["Fable of the Mirror-Breaker", "Reflection of Kiki-Jiki"]]);
    expect(backFace(undefined)).toBeNull();
  });

  it("writes the order as N Name lines, A to Z", () => {
    expect(orderText([{ card: "b", qty: 1 }, { card: "Ark", qty: 1 }, { card: "b", qty: 2 }])).toBe("1 Ark\n3 b\n");
  });

  it("a print on a received order has arrived; on a draft order it's for the next order", () => {
    const arrived = orders.map((o) => (o.key === "proxy-1" ? { ...o, status: "received" as const } : o));
    const p = printPlan({ ...bundle, orders: arrived }, { answers, today: "2026-10-19" });
    expect(p.placed).toEqual([]);
    expect(p.received[0]!.count).toBe(4);
    const byKey = new Map(arrived.map((o) => [o.key, o]));
    expect(deckCounts(alpha, swaps, answers, byKey).printsOnOrder).toBe(0);
    expect(deckCounts(alpha, swaps, answers, new Map(orders.map((o) => [o.key, o]))).printsOnOrder).toBe(4);
    expect(swapStatus(swaps[1]!, deckLogs(alpha), (k) => k ?? "", byKey)).toEqual({ label: "Print arrived", tone: "good" });
    const draft = orders.map((o) => (o.key === "proxy-1" ? { ...o, status: "draft" as const } : o));
    expect(printPlan({ ...bundle, orders: draft }, { answers, today: "2026-10-19" }).next.count).toBe(5);
    expect(deckCounts(alpha, swaps, answers, new Map(draft.map((o) => [o.key, o]))).printsNext).toBe(4);
  });
});

// ── spares ─────────────────────────────────────────────────────────────────

describe("spares", () => {
  const sp = spares(bundle, answers);
  const find = (list: typeof sp.now, card: string) => list.find((s) => s.card === card);

  it("a fill takes the card out now; a move that waits for another deck keeps it until prints arrive", () => {
    expect(find(sp.now, "Off Color")?.why).toBe("A basic land holds the slot until the Volcano print arrives.");
    expect(find(sp.after, "Off Color")).toBeUndefined();
    expect(find(sp.now, "Primordial")).toBeUndefined();
    expect(find(sp.after, "Primordial")?.why).toBe("Leaves when Guide moves in from Alpha, once your prints arrive.");
  });

  it("stand-ins become spares when their print arrives, with the later cut shown as a suggestion only", () => {
    const stand = find(sp.after, "Stand B")!;
    expect(stand.why).toBe("A stand-in: leaves when the Print B print arrives.");
    expect(stand.laterOut).toBe("New A");
    expect(laterOutText(stand)).toBe(
      "Its later cut, New A, is a suggestion and not part of the plan. If you keep Stand B when the print arrives and take out New A instead, New A is the spare, not Stand B.",
    );
    expect(find(sp.now, "Old B")?.why).toBe("Replaced by the stand-in Stand B until the Print B print arrives.");
  });

  it("marks spares another deck's plan takes, and ones a proposal would use", () => {
    const guide = find(sp.after, "Guide")!;
    expect(guide.why).toBe("Leaves when the Ark print arrives.");
    expect(guide.usedIn.map((u) => [u.deck?.name, u.when])).toEqual([["Beta", "after"]]);
    expect(guide.free).toBe(false);
    const prim = find(sp.after, "Primordial")!;
    expect(prim.proposedFor.map((u) => [u.deck?.name, u.decision])).toEqual([["Gamma", null]]);
    expect(prim.free).toBe(true);
    expect(find(sp.now, "Old A")?.proposedFor.map((u) => u.deck?.name)).toEqual(["Gamma"]);
  });

  it("lists cards your own change took out, and basics only when a plan swap cuts them", () => {
    expect(sp.before.map((s) => [s.card, s.why])).toEqual([["Stock Land", "Taken out for Off Color, your own change before the plans."]]);
    expect(find(sp.after, "Forest")?.why).toBe("Leaves when the Fable of the Mirror-Breaker print arrives.");
    // The Island that holds Volcano's slot for now isn't a spare.
    expect(find(sp.after, "Island")).toBeUndefined();
  });
});

// ── marks, stock checks and the overview ───────────────────────────────────

describe("marks and counts", () => {
  it("follows aliases for marks, newer wins, and keeps marks with no live swap as orphans", () => {
    const m = markIndex(
      {
        "p-old-marked": { installed: mark(true, "2026-10-19T01:00:00Z") },
        "p-marked": { installed: mark(false, "2026-10-19T02:00:00Z") },
        "plan|Gone|X|Y": { installed: mark(true, "2026-10-19T01:00:00Z") },
        "plan|Gone|Z|Y": { installed: mark(false, "2026-10-19T01:00:00Z") },
      },
      bundle.aliases,
      live,
    );
    expect(m.marks.get("p-marked")?.installed?.value).toBe(false);
    expect(m.orphans.map(([k]) => k)).toEqual(["plan|Gone|X|Y"]);
  });

  it("a newer sold-out check at a local store wins over an older in-stock one", () => {
    const local = stores[0]!;
    const q = (checked: string, in_stock: boolean) => quote({ swap: "p1", card: "C", store: local.key, checked, in_stock });
    const s = swap({ key: "p1", deck: "beta", in: "C", stage: "proposed" });
    expect(ownedOrStockedLocally([q("2026-10-01", true), q("2026-10-18", false)], [local])(s)).toBe(false);
    expect(ownedOrStockedLocally([q("2026-10-01", false), q("2026-10-18", true)], [local])(s)).toBe(true);
  });

  it("counts what's waiting to be installed, and the overview's figures", () => {
    const logs = deckLogs(alpha);
    expect(inHand(swaps[0]!, logs)).toBe(true); // bought
    expect(inHand(swaps[2]!, logs)).toBe(true); // a stand-in in the deck
    expect(inHand(swaps[1]!, logs)).toBe(false); // a print on order
    const marks = markIndex({ "plan|Alpha|New A|Old A": { installed: mark(true, "2026-10-19T01:00:00Z") } }, {}, live).marks;
    const c = overviewCounts(bundle, { answers, marks, today: "2026-10-19" });
    expect(c).toMatchObject({ toReview: 7, toBuy: 6, buyTotal: 4, buyUnpriced: 3, printsOnOrder: 4, printsNext: 1, waitingToInstall: 1, installed: 1 });
    expect(c.sparesNow).toBeGreaterThan(0);
  });

  // The planner's install record (data/upgrades.json in commander-decks) comes in as swap.upgrade.
  const imported = "2026-10-19T03:00:00Z";
  const withStatus = (status: string) =>
    swaps.map((s) => (s.key === "plan|Alpha|New A|Old A" || s.key === "standin|Alpha|Stand B" ? { ...s, upgrade: { id: `upgrade-${s.in}`, status }, updated_at: imported } : s));

  it("starts from the planner's install record: installed is ticked, skipped isn't waiting", () => {
    const none = new Map();
    const installed = overviewCounts({ ...bundle, swaps: withStatus("installed") }, { answers, marks: none, today: "2026-10-19" });
    expect([installed.waitingToInstall, installed.installed]).toEqual([0, 2]);
    const skipped = overviewCounts({ ...bundle, swaps: withStatus("skipped") }, { answers, marks: none, today: "2026-10-19" });
    expect([skipped.waitingToInstall, skipped.installed]).toEqual([0, 0]);
    // planned or ordered says nothing about the deck
    const ordered = overviewCounts({ ...bundle, swaps: withStatus("ordered") }, { answers, marks: none, today: "2026-10-19" });
    expect([ordered.waitingToInstall, ordered.installed]).toEqual([2, 0]);
    const s = withStatus("installed")[0]!;
    expect(installedState(s, undefined)).toEqual({ on: true, skipped: false, from: "plan", planStatus: "installed" });
  });

  it("a tick here newer than the import wins over the planner's record; an older one doesn't", () => {
    const s = withStatus("installed")[0]!;
    expect(installedState(s, mark(false, "2026-10-19T04:00:00Z"))).toEqual({ on: false, skipped: false, from: "yama", planStatus: "installed" });
    expect(installedState(s, mark(false, "2026-10-19T02:00:00Z"))).toEqual({ on: true, skipped: false, from: "plan", planStatus: "installed" });
    const skipped = withStatus("skipped")[0]!;
    expect(installedState(skipped, mark(true, "2026-10-19T04:00:00Z")).on).toBe(true);
    expect(installedState(skipped, mark(true, "2026-10-19T02:00:00Z"))).toMatchObject({ on: false, skipped: true, from: "plan" });
    // No record from the planner: the tick is all there is.
    expect(installedState(swaps[0]!, mark(true, "2026-01-01T00:00:00Z"))).toMatchObject({ on: true, from: "yama", planStatus: null });
    const marks = markIndex({ "plan|Alpha|New A|Old A": { installed: mark(false, "2026-10-19T04:00:00Z") } }, {}, live).marks;
    const c = overviewCounts({ ...bundle, swaps: withStatus("installed") }, { answers, marks, today: "2026-10-19" });
    expect([c.waitingToInstall, c.installed]).toEqual([1, 1]);
  });
});
