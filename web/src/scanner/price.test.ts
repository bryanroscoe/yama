import { describe, expect, it } from "vitest";
import { priceFor, priceTie, sessionTotal, worthIt, type RecentCard } from "./price";
import { BUZZ, DEFAULT_WORTH, filedBuzz, filedSound, PITCH, pitchFor, priceTone } from "./sounds";

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

describe("tie by price (opt-in, item 26)", () => {
  const p = (id: string, usd: number | null, extra: Record<string, unknown> = {}) => ({ scryfall_id: id, lang: "en", finishes: ["nonfoil", "foil"], usd, usd_foil: null, usd_etched: null, price_date: "2026-11-20", ...extra });

  it("takes the dearest when every printing is priced within 15% of the cheapest", () => {
    expect(priceTie([p("a", 1.0), p("b", 1.12), p("c", 1.05)], "nonfoil")).toMatchObject({ printing: { scryfall_id: "b" }, low: 1, high: 1.12 });
  });

  it("is no tie past 15%, with a price missing (unknown, never near), for a proxy, or with fewer than two", () => {
    expect(priceTie([p("a", 1.0), p("b", 1.2)], "nonfoil")).toBeNull();
    expect(priceTie([p("a", 1.0), p("b", null)], "nonfoil")).toBeNull();
    expect(priceTie([p("a", 1.0), p("b", 1.0)], "proxy")).toBeNull();
    expect(priceTie([p("a", 1.0)], "nonfoil")).toBeNull();
  });

  it("prices each in the finish it would be filed in, and weighs English printings only when there are any", () => {
    // Foil chosen, no foil prices: unknown, so no tie.
    expect(priceTie([p("a", 1.0), p("b", 1.0)], "foil")).toBeNull();
    // A foil-only printing is filed foil.
    expect(priceTie([p("a", 2, { usd_foil: 2.1 }), p("b", 9, { finishes: ["foil"], usd_foil: 2.2 })], "foil")).toMatchObject({ printing: { scryfall_id: "b" } });
    // The Japanese printing is left out, as choosePrinting leaves it.
    expect(priceTie([p("a", 1.0), p("b", 1.1), p("ja", 40, { lang: "ja" })], "nonfoil")).toMatchObject({ printing: { scryfall_id: "b" } });
  });
});

describe("feedback by price (item 28)", () => {
  it("pitches the chime by price on a log scale, low for bulk and high for a dear card", () => {
    expect(pitchFor(0.05)).toBe(PITCH.low);
    expect(pitchFor(0.1)).toBe(PITCH.low);
    expect(pitchFor(500)).toBe(PITCH.high);
    expect(pitchFor(1)).toBeGreaterThan(pitchFor(0.25));
    expect(pitchFor(10)).toBeGreaterThan(pitchFor(1));
  });

  it("never gives an unknown price a pitch, least of all the cheap one: an even two-note chime", () => {
    const unknown = priceTone(null, DEFAULT_WORTH);
    expect(unknown.notes.map((n) => n[0])).toEqual([880, 880]);
    expect(unknown.notes[0]![0]).toBeGreaterThan(PITCH.low);
    // A priced card's chime rises; one worth the threshold adds the bright top note.
    const cheap = priceTone(0.2, DEFAULT_WORTH);
    expect(cheap.notes).toHaveLength(2);
    expect(cheap.notes[1]![0]).toBeGreaterThan(cheap.notes[0]![0]);
    expect(priceTone(12, DEFAULT_WORTH).notes).toHaveLength(3);
  });

  it("buzzes twice for a card worth the threshold, and briefly otherwise (a missing price never is worth it)", () => {
    expect(filedBuzz(12, 2)).toEqual([...BUZZ.valuable]);
    expect(filedBuzz(1, 2)).toBe(BUZZ.filed);
    expect(filedBuzz(null, 0)).toBe(BUZZ.filed);
  });
});

describe("card first, printing after, in the strip's total", () => {
  it("leaves a card without a printing out of the total and the unpriced count", () => {
    const total = sessionTotal([card({ finish: "nonfoil" }), card({ key: "w", state: "finding", prices: null }), card({ key: "p", state: "pick", prices: null })]);
    expect(total).toEqual({ total: 1.1, priced: 1, missing: 0 });
  });
});

