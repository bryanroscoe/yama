import { describe, expect, it } from "vitest";
import { priceFor, sessionTotal, worthIt, type RecentCard } from "./price";
import { DEFAULT_WORTH, filedSound } from "./sounds";

const prices = { usd: 1.1, usd_foil: 3.2, usd_etched: null, date: "2026-11-14" };
const card = (over: Partial<RecentCard> = {}): RecentCard => ({ key: "k", name: "Westvale Abbey", set: "soi", number: "281", finish: "foil", copies: 1, prices, ...over });

describe("scanner prices", () => {
  it("takes the printing's price for its finish, and none for a proxy or a missing one", () => {
    expect(priceFor(prices, "nonfoil")).toBe(1.1);
    expect(priceFor(prices, "foil")).toBe(3.2);
    expect(priceFor(prices, "etched")).toBeNull();
    expect(priceFor(prices, "proxy")).toBeNull();
    expect(priceFor(null, "foil")).toBeNull();
  });

  it("calls a card worth it at or over the threshold, never with a missing price", () => {
    expect(worthIt(5, 5)).toBe(true);
    expect(worthIt(4.99, 5)).toBe(false);
    expect(worthIt(null, 0)).toBe(false);
    expect(worthIt(0, 0)).toBe(true);
  });

  it("chooses the louder sound only for a card worth the threshold", () => {
    expect(DEFAULT_WORTH).toBe(2);
    expect(filedSound(12, DEFAULT_WORTH)).toBe("valuable");
    expect(filedSound(3.2, DEFAULT_WORTH)).toBe("valuable");
    expect(filedSound(1.5, DEFAULT_WORTH)).toBe("filed");
    expect(filedSound(null, 0)).toBe("filed");
  });

  it("totals priced copies only, and says how many had no price", () => {
    const t = sessionTotal([card(), card({ finish: "nonfoil", copies: 2 }), card({ finish: "etched" }), card({ finish: "proxy" })]);
    expect(t).toEqual({ total: 5.4, priced: 3, missing: 1 });
  });
});
