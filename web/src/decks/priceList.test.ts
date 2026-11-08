import { describe, expect, it } from "vitest";
import type { DeckEntry } from "../api";
import { groupsIn, leaveOut, priceRows, priceSourceLine, priceText, priceTotal, shownRows } from "./priceList";

const entry = (name: string, o: Partial<DeckEntry>): DeckEntry => ({
  oracle_id: name.toLowerCase(),
  name,
  qty: 1,
  board: "main",
  card: null,
  owned: 0,
  in_deck_container: 0,
  proxies: 0,
  locations: {},
  needed: 0,
  cheapest_usd: null,
  printing: null,
  produced_mana: null,
  ...o,
});

const typed = (type_line: string) => ({ card: { type_line } as DeckEntry["card"] });

const cards: DeckEntry[] = [
  entry("Plateau", { ...typed("Land — Mountain Plains"), proxies: 1, cheapest_usd: 610.5, cheapest_printing: { scryfall_id: "p", set_code: "3ed", set_name: "Revised Edition", collector_number: "283", date: "2026-11-04" } }),
  entry("Sol Ring", { ...typed("Artifact"), owned: 1, cheapest_usd: 1.25, cheapest_printing: { scryfall_id: "s", set_code: "cmm", set_name: "Commander Masters", collector_number: "410", date: "2026-11-07" } }),
  entry("Plains", { ...typed("Basic Land — Plains"), qty: 11, owned: 8, proxies: 1, cheapest_usd: 0.1 }),
  entry("Unpriced Card", { needed: 1 }),
  entry("Sideboard Card", { board: "side", cheapest_usd: 99 }),
];

describe("the deck's price list", () => {
  const rows = priceRows(cards);

  it("splits each card into real copies, proxies and what's missing, without the sideboard", () => {
    expect(rows.map((r) => [r.name, r.real, r.proxy, r.need])).toEqual([
      ["Plateau", 0, 1, 0],
      ["Sol Ring", 1, 0, 0],
      ["Plains", 8, 1, 2],
      ["Unpriced Card", 0, 0, 1],
    ]);
  });

  it("puts the priciest first and cards with no price last", () => {
    expect(shownRows(rows, "all", "price").map((r) => r.name)).toEqual(["Plateau", "Sol Ring", "Plains", "Unpriced Card"]);
    expect(shownRows(rows, "proxy", "name").map((r) => r.name)).toEqual(["Plains", "Plateau"]);
  });

  it("totals only known prices, and leaves basics out of what's still needed", () => {
    expect(priceTotal(rows, "all")).toEqual({ usd: 612.85, copies: 14, unpriced: 1, basics: 0 });
    expect(priceTotal(rows, "proxy")).toEqual({ usd: 610.6, copies: 2, unpriced: 0, basics: 0 });
    expect(priceTotal(rows, "need")).toEqual({ usd: null, copies: 3, unpriced: 1, basics: 2 });
  });

  it("keeps each card's own price date: the range, and the date of a card priced earlier", () => {
    expect(priceSourceLine(rows, null)).toBe("TCGplayer market via Scryfall, Nov 4 to Nov 7");
    expect(priceSourceLine(rows.filter((r) => r.name === "Sol Ring"), null)).toBe("TCGplayer market via Scryfall, Nov 7");
    expect(priceSourceLine([], "2026-11-06")).toBe("TCGplayer market via Scryfall, Nov 6");
  });

  it("copies as text a friend can read", () => {
    const text = priceText(shownRows(rows, "all", "price"), "all", "TCGplayer market via Scryfall, Nov 7");
    expect(text.split("\n")).toEqual([
      "1 Plateau, proxy: $610.50 at Revised Edition (3ED 283), price from Nov 4",
      "1 Sol Ring: $1.25 at Commander Masters (CMM 410)",
      "11 Plains, 8 real, 1 proxy, 2 not owned: $1.10 ($0.10 each)",
      "1 Unpriced Card, not owned: no price",
      "",
      "Total: $612.85 for 14 cards (1 without a price).",
      "Cheapest nonfoil paper printing of each card, TCGplayer market via Scryfall, Nov 7. Market prices, not store quotes.",
    ]);
  });

  it("leaves whole groups out, such as lands, and says what they come to", () => {
    expect(groupsIn(rows)).toEqual(["Artifacts", "Lands", "Other"]);
    const { kept, left } = leaveOut(rows, new Set(["Lands"]));
    expect(kept.map((r) => r.name)).toEqual(["Sol Ring", "Unpriced Card"]);
    expect(priceTotal(kept, "all")).toEqual({ usd: 1.25, copies: 2, unpriced: 1, basics: 0 });
    const text = priceText(shownRows(kept, "all", "price"), "all", "TCGplayer market via Scryfall, Nov 7", { groups: ["Lands"], rows: left });
    expect(text.split("\n").slice(-3)).toEqual([
      "Total: $1.25 for 2 cards (1 without a price).",
      "Left out: Lands, $611.60 for 12 cards.",
      "Cheapest nonfoil paper printing of each card, TCGplayer market via Scryfall, Nov 7. Market prices, not store quotes.",
    ]);
    // Under still need, a left-out basic is named as not counted, not shown as having no price.
    const need = priceText(shownRows(kept, "need", "price"), "need", "x", { groups: ["Lands"], rows: left });
    expect(need.split("\n").at(-2)).toBe("Left out: Lands, 2 cards (2 basic lands not counted).");
  });
});
