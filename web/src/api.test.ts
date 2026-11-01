import { describe, expect, it } from "vitest";
import { priceSource, shortDate, usd } from "./api";

describe("prices", () => {
  it("never shows a missing price as $0", () => {
    expect(usd(null)).toBe("No price");
    expect(usd(0.5)).toBe("$0.50");
    expect(usd(1630.766)).toBe("$1,630.77");
  });
  it("reads a snapshot date as a local date", () => {
    expect(shortDate("2026-10-19")).toBe("Oct 19");
    expect(shortDate(null)).toBeNull();
  });
  it("names the source and date", () => {
    expect(priceSource("2026-10-18")).toBe("TCGplayer market via Scryfall, Oct 18");
    expect(priceSource(undefined)).toBe("TCGplayer market via Scryfall, date unknown");
  });
});
