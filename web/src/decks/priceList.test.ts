import { describe, expect, it } from "vitest";
import type { DeckEntry } from "../api";
import { priceRows, priceText, priceTotal, shownRows } from "./priceList";

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

const cards: DeckEntry[] = [
  entry("Plateau", { proxies: 1, cheapest_usd: 610.5, cheapest_printing: { scryfall_id: "p", set_code: "3ed", set_name: "Revised Edition", collector_number: "283" } }),
  entry("Sol Ring", { owned: 1, cheapest_usd: 1.25, cheapest_printing: { scryfall_id: "s", set_code: "cmm", set_name: "Commander Masters", collector_number: "410" } }),
  entry("Plains", { qty: 11, owned: 8, proxies: 1, cheapest_usd: 0.1 }),
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

  it("copies as text a friend can read", () => {
    const text = priceText(shownRows(rows, "all", "price"), "all", "TCGplayer market via Scryfall, Nov 7");
    expect(text.split("\n")).toEqual([
      "1 Plateau, proxy: $610.50 at Revised Edition (3ED 283)",
      "1 Sol Ring: $1.25 at Commander Masters (CMM 410)",
      "11 Plains, 1 proxied: $1.10 ($0.10 each)",
      "1 Unpriced Card, not owned: no price",
      "",
      "Total: $612.85 for 14 cards (1 without a price).",
      "Cheapest nonfoil paper printing of each card, TCGplayer market via Scryfall, Nov 7. Market prices, not store quotes.",
    ]);
  });
});
