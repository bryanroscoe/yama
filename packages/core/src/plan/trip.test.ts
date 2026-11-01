import { describe, expect, test } from "vitest";
import fixture from "./fixtures/trip.json";
import { judge, localBuyRule, planTrip, ruleText, storePreference, tripSummary, type LocalBuyRule, type TripData } from "./trip";
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
  test.each(fixture.cases)("matches the fixture the Rust port also checks ($today)", (c) => {
    expect(tripSummary(planTrip(bundle, { today: c.today }))).toEqual(c.expect);
  });

  test("a store without a preference is fine to go; a never store is skipped but counted", () => {
    expect(storePreference(bundle, "pats")).toBe("default");
    expect(storePreference(bundle, "black-castle")).toBe("ok");
    expect(storePreference({}, "pats")).toBe("ok");
    const t = planTrip(bundle, { today: "2026-11-01" });
    expect(t.stops.map((s) => s.store.key)).not.toContain("alpha-strike");
    expect(t.print.find((p) => p.want.card === "Strike It Rich")?.stores).toEqual(["Alpha Strike Games"]);
  });

  test("a maybe store is visited only for cards no other store has", () => {
    const t = planTrip(bundle, { today: "2026-11-01" });
    const multiverse = t.stops.find((s) => s.store.key === "multiverse-hobbies")!;
    expect(multiverse.rows.map((r) => r.want.card)).toEqual(["Exotic Orchard"]);
    // Without that card, it isn't worth the trip.
    const fewer = { ...bundle, swaps: bundle.swaps.filter((s) => s.in !== "Exotic Orchard") };
    expect(planTrip(fewer, { today: "2026-11-01" }).stops.map((s) => s.store.key)).toEqual(["pats", "mothership"]);
  });

  test("your chosen cut, carts, and totals that never count a missing price as $0", () => {
    const t = planTrip(bundle, { today: "2026-11-01" });
    const pats = t.stops[0]!;
    expect(pats.rows.find((r) => r.want.card === "Swords to Plowshares")?.want.replaces).toBe("Swift Cut");
    expect(pats.cartUrl).toBe("https://patsgames.com/cart/v-fell:1,v-swords:1");
    expect(t.stops.find((s) => s.store.key === "multiverse-hobbies")?.cartUrl).toBeNull();
    expect(t.stops.find((s) => s.store.key === "multiverse-hobbies")?.noCartLine).toBe(1);
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
