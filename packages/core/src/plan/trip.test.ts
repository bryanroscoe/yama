import { describe, expect, test } from "vitest";
import fixture from "./fixtures/trip.json";
import { foilListing, judge, localBuyRule, planTrip, ruleText, storePreference, tripSummary, type LocalBuyRule, type TripData } from "./trip";
import type { RuleSet } from "./rules";

const bundle = fixture.bundle as unknown as TripData;
const BRYAN: LocalBuyRule = { max_usd: 2, always_ok_usd: 0.5, tiers: [{ market_under: 1, max_multiple: 2 }, { market_under: null, max_multiple: 1.5 }] };

describe("the local buy rule", () => {
  test("Bryan's 2026-10-28 rule, at its edges", () => {
    expect(judge(BRYAN, 0.5, null)).toBe("ok"); // $0.50 or less whatever the market
    expect(judge(BRYAN, 0.51, null)).toBe("no-market"); // unknown market: only at $0.50 or less
    expect(judge(BRYAN, 0.5, 0.05)).toBe("ok");
    expect(judge(BRYAN, 1.0, 0.5)).toBe("ok"); // 2× under $1
    expect(judge(BRYAN, 1.01, 0.5)).toBe("over-market");
    expect(judge(BRYAN, 1.5, 1.0)).toBe("ok"); // 1.5× from $1
    expect(judge(BRYAN, 1.51, 1.0)).toBe("over-market");
    expect(judge(BRYAN, 2.0, 1.9)).toBe("ok");
    expect(judge(BRYAN, 2.01, 5)).toBe("over-max"); // over $2: print it
    expect(judge(null, 40, 1)).toBe("ok"); // no rule: every listed price counts
  });

  test("says what it is", () => {
    expect(ruleText(BRYAN)).toBe(
      "Buy locally: at most $2.00; $0.50 or less whatever the market; at most 2× market when market is under $1.00; at most 1.5× market when market is $1.00 or more; an unknown market qualifies only at $0.50 or less.",
    );
  });

  test("an older rule set without local_buy is read from its ceiling and limit, and says so", () => {
    const set = (bundle.settings as unknown as RuleSet[])[0]!;
    const r = localBuyRule(set);
    expect(r.derived).toBe(true);
    expect(r.rule).toEqual({ max_usd: 3, always_ok_usd: null, tiers: [{ market_under: null, max_multiple: 1.25 }] });
    expect(r.text).toContain("this rule set has no local buy rule");
    expect(localBuyRule(null).rule).toBeNull();
  });
});

describe("the trip", () => {
  test.each(fixture.cases)("matches the fixture the Rust port also checks ($today, $stores)", (c) => {
    const stores = "stores" in c ? (c.stores as string[]) : null;
    expect(tripSummary(planTrip(bundle, { today: c.today, stores }))).toEqual(c.expect);
  });

  test("preferences: none is fine to go, the old name for a favourite still reads, a never store is skipped but counted", () => {
    expect(storePreference(bundle, "black-castle")).toBe("favorite");
    expect(storePreference(bundle, "pats")).toBe("ok");
    expect(storePreference({}, "pats")).toBe("ok");
    expect(storePreference({ store_prefs: { pats: { preference: "default", note: null, updated_at: "" } } }, "pats")).toBe("favorite");
    const t = planTrip(bundle, { today: "2026-11-01" });
    expect(t.stops.map((s) => s.store.key)).not.toContain("alpha-strike");
    expect(t.print.find((p) => p.want.card === "Strike It Rich")?.stores).toEqual(["Alpha Strike Games"]);
  });

  test("the favourite gets a tie, and a card within its premium; ease decides between equal stores", () => {
    const t = planTrip(bundle, { today: "2026-11-01" });
    const bc = t.stops[0]!;
    expect(bc.store.key).toBe("black-castle");
    // Fellwar Stone is $0.50 at Pat's and Black Castle; Sol Ring is $1.50 there, $1.25 at Mothership.
    expect(bc.rows.map((r) => [r.want.card, r.offer.price])).toEqual([["Fellwar Stone", 0.5], ["Sol Ring", 1.5]]);
    // Swords is $1.00 at Pat's and Mothership: Mothership is easier to get to.
    expect(t.stops.map((s) => s.store.key)).toEqual(["black-castle", "mothership", "multiverse-hobbies"]);
    const noPremium = { ...bundle, store_prefs: { ...bundle.store_prefs, "black-castle": { ...bundle.store_prefs!["black-castle"]!, premium_usd: null } } };
    const plain = planTrip(noPremium, { today: "2026-11-01" });
    expect(plain.stops.find((s) => s.store.key === "mothership")!.rows.map((r) => r.want.card)).toContain("Sol Ring");
    const demoted = { ...bundle, store_prefs: { ...bundle.store_prefs, "black-castle": { ...bundle.store_prefs!["black-castle"]!, preference: "ok" as const } } };
    expect(planTrip(demoted, { today: "2026-11-01" }).stops.find((s) => s.store.key === "mothership")!.rows.map((r) => r.want.card)).toContain("Sol Ring");
    const easierPats = { ...bundle, store_prefs: { ...bundle.store_prefs, pats: { ...bundle.store_prefs!.pats!, hassle: 2 }, mothership: { ...bundle.store_prefs!.mothership!, hassle: 3 } } };
    expect(planTrip(easierPats, { today: "2026-11-01" }).stops.map((s) => s.store.key)).toEqual(["black-castle", "pats", "multiverse-hobbies"]);
  });

  test("a maybe store is visited only for cards no other store has", () => {
    const t = planTrip(bundle, { today: "2026-11-01" });
    const multiverse = t.stops.find((s) => s.store.key === "multiverse-hobbies")!;
    expect(multiverse.rows.map((r) => r.want.card)).toEqual(["Exotic Orchard"]);
    const fewer = { ...bundle, swaps: bundle.swaps.filter((s) => s.in !== "Exotic Orchard") };
    expect(planTrip(fewer, { today: "2026-11-01" }).stops.map((s) => s.store.key)).toEqual(["black-castle", "mothership"]);
  });

  test("a maybe store doesn't win by bundling cards the other stores have", () => {
    const at = (card: string, price: number) => ({ ...bundle.quotes.find((q) => q.card === "Exotic Orchard")!, card, price, variant: null });
    const fewer = { ...bundle, swaps: bundle.swaps.filter((s) => s.in !== "Exotic Orchard") };
    const plain = planTrip(fewer, { today: "2026-11-01" });
    const bundled = planTrip({ ...fewer, quotes: [...fewer.quotes, at("Sol Ring", 1.25), at("Fellwar Stone", 0.5), at("Swords to Plowshares", 1)] }, { today: "2026-11-01" });
    expect(bundled.stops.map((s) => s.store.key)).toEqual(["black-castle", "mothership"]);
    expect(bundled.alternatives).toEqual(plain.alternatives);
  });

  test("a store left out only by the buy-local rule says so, not that you won't go", () => {
    const settings = bundle.settings.map((s) => ({ ...s, rules: { ...s.rules, buy_local_only: true } }));
    const stores = bundle.stores.map((s) => (s.key === "mothership" ? { ...s, kind: "online" as const } : s));
    const quotes = bundle.quotes.filter((q) => !(q.card === "Sol Ring" && q.store === "black-castle"));
    const t = planTrip({ ...bundle, settings, stores, quotes }, { today: "2026-11-01" });
    expect(t.print.find((p) => p.want.card === "Sol Ring")).toMatchObject({ reason: "not-local", stores: ["Mothership Books and Games"] });
    expect(t.skipped.find((x) => x.store.key === "mothership")?.why).toBe("not-local");
  });

  test("a foil listing never qualifies, whatever else it says; unknown stock isn't a reason to go", () => {
    expect(foilListing("Borderless Foil")).toBe(true);
    expect(foilListing("Near Mint Non-Foil")).toBe(false);
    expect(foilListing("Etched Foil")).toBe(true);
    expect(foilListing(null)).toBe(false);
    const quotes = bundle.quotes.map((q) => (q.card === "Exotic Orchard" ? { ...q, in_stock: null } : q));
    const t = planTrip({ ...bundle, quotes }, { today: "2026-11-01" });
    expect(t.stops.map((s) => s.store.key)).not.toContain("multiverse-hobbies");
    expect(t.print.find((p) => p.want.card === "Exotic Orchard")?.reason).toBe("unknown-stock");
    const cad = planTrip({ ...bundle, quotes: bundle.quotes.map((q) => (q.card === "Exotic Orchard" ? { ...q, currency: "CAD" } : q)) }, { today: "2026-11-01" });
    expect(cad.print.find((p) => p.want.card === "Exotic Orchard")?.reason).toBe("no-price");
  });

  test("a store left off this trip is named, not used", () => {
    const t = planTrip(bundle, { today: "2026-11-01", stores: ["black-castle", "pats"] });
    expect(t.going).toEqual(["black-castle", "pats"]);
    expect(t.stops.map((s) => s.store.key)).toEqual(["black-castle", "pats"]);
    expect(t.print.find((p) => p.want.card === "Exotic Orchard")).toMatchObject({ reason: "left-out", stores: ["Multiverse Hobbies"] });
    expect(t.skipped.map((s) => [s.store.key, s.why])).toEqual([["mothership", "left-out"], ["alpha-strike", "never"], ["multiverse-hobbies", "left-out"]]);
  });

  test("carts, lists to paste, and totals that never count a missing price as $0", () => {
    const t = planTrip(bundle, { today: "2026-11-01", stores: ["black-castle", "pats", "multiverse-hobbies"] });
    const pats = t.stops.find((s) => s.store.key === "pats")!;
    expect(pats.rows.find((r) => r.want.card === "Swords to Plowshares")?.want.replaces).toBe("Swift Cut");
    expect(pats.paste).toBe("1 Swords to Plowshares");
    expect(t.stops[0]!.search.map((x) => x.card)).toEqual(["Fellwar Stone", "Sol Ring"]);
    expect(t.stops.find((s) => s.store.key === "multiverse-hobbies")?.cartUrl).toBeNull();
    expect(t.stops.find((s) => s.store.key === "multiverse-hobbies")?.noCartLine).toBe(1);
    expect(t.printPaste.split("\n")).toContain("1 Mana Vault");
    const all = planTrip(bundle, { today: "2026-11-01", stores: ["mothership"] });
    expect(all.stops[0]!.cartUrl).toBe("https://mothershipatx.com/cart/v-sol:1");
    const none = planTrip({ ...bundle, quotes: [] }, { today: "2026-11-01" });
    expect(none.total).toBeNull();
    expect(none.stops).toEqual([]);
    expect(none.print.every((p) => p.reason === "no-check")).toBe(true);
  });

  test("a newer answer on this device moves a proposal, and a bought card leaves", () => {
    const answers = new Map([["p-brain", { decision: "want", note: null, cut: null, deck: "tricky", card: "Brainstorm", at: "2026-11-01T00:00:00Z", origin: "yama" } as const]]);
    const t = planTrip(bundle, { today: "2026-11-01", answers, bought: (k) => k === "s-sol" });
    const cards = t.stops.flatMap((s) => s.rows.map((r) => r.want.card));
    expect(cards).toContain("Brainstorm");
    expect(cards).not.toContain("Sol Ring");
    expect(cards).not.toContain("Swords to Plowshares"); // the bundle's want isn't in this answer map, so it rides along
  });
});
