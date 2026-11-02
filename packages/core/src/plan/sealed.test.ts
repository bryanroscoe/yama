import { describe, expect, test } from "vitest";
import { sealedFor } from "./sealed";
import type { SealedQuote, SealedView } from "./types";

const quote = (id: string, store: string, price: number | null, extra: Partial<SealedQuote> = {}): SealedQuote => ({
  id,
  store,
  store_name: store,
  preference: "ok",
  store_live: true,
  price,
  in_stock: true,
  checked_on: "2026-11-01",
  note: null,
  over_cap: null,
  vs_market_pct: null,
  vs_singles_pct: null,
  ...extra,
});

const saved: SealedView = {
  date: "2026-11-01",
  cap_usd: 51,
  items: [
    { want: "w", name: "Federation Fleet", qty: 1, priority: "need", why: null, precon: null, market: null, singles: null, best: "a", quotes: [quote("a", "pats", 45), quote("b", "mothership", 49.99), quote("c", "black-castle", 60)] },
  ],
};
const rules = (from: string, cap: number) => ({ effective_from: from, rules: { sealed_max_usd: cap }, note: null, origin: "yama" });

describe("the saved sealed view, offline", () => {
  test("the cap is the one in force on your day, and each price is judged by it", () => {
    const v = sealedFor(saved, [rules("2026-10-28", 51), rules("2026-11-02", 40)], "2026-11-02", null, []);
    expect(v.cap_usd).toBe(40);
    expect(v.items[0]!.quotes.map((q) => q.over_cap)).toEqual([true, true, true]);
    expect(v.items[0]!.best).toBeNull();
  });

  test("the pick is among the stores going this time; along the way, only stores on the trip", () => {
    const set = [rules("2026-10-28", 51)];
    expect(sealedFor(saved, set, "2026-11-01", ["mothership", "black-castle"], []).items[0]!.best).toBe("b");
    const along = { ...saved, items: [{ ...saved.items[0]!, priority: "along" as const }] };
    expect(sealedFor(along, set, "2026-11-01", null, []).items[0]!.best).toBeNull();
    expect(sealedFor(along, set, "2026-11-01", null, ["mothership"]).items[0]!.best).toBe("b");
  });

  test("no cap: the cheapest in stock at a live store you'll go to", () => {
    const v = sealedFor({ ...saved, items: [{ ...saved.items[0]!, quotes: [quote("a", "pats", 45, { store_live: false }), quote("c", "black-castle", 60)] }] }, [], "2026-11-01", null, []);
    expect(v.cap_usd).toBeNull();
    expect(v.items[0]!.best).toBe("c");
  });
});
