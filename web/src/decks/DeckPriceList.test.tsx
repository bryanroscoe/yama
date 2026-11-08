import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeckEntry, DeckView } from "../api";
import { DeckPriceList } from "./DeckPriceList";

const entry = (name: string, type_line: string, o: Partial<DeckEntry>): DeckEntry => ({
  oracle_id: name.toLowerCase(), name, qty: 1, board: "main", card: { type_line } as DeckEntry["card"],
  owned: 0, in_deck_container: 0, proxies: 0, locations: {}, needed: 0, cheapest_usd: null, printing: null, produced_mana: null, ...o,
});

const deck = {
  cards: [
    entry("Plateau", "Land — Mountain Plains", { proxies: 1, cheapest_usd: 610.5, cheapest_printing: { scryfall_id: "p", set_code: "3ed", set_name: "Revised Edition", collector_number: "283" } }),
    entry("Sol Ring", "Artifact", { owned: 1, cheapest_usd: 1.25, printing: { set_code: "sld", collector_number: "1011", finish: "foil", from: "owned" }, cheapest_printing: { scryfall_id: "s", set_code: "cmm", set_name: "Commander Masters", collector_number: "410" } }),
  ],
  ownership: { price_date: "2026-11-07" },
} as unknown as DeckView;

describe("the deck page's Prices view", () => {
  it("lists each card's price, kind, cheapest printing and your own printing", () => {
    const html = renderToStaticMarkup(<DeckPriceList deck={deck} onOpen={() => {}} />);
    expect(html).toContain("Plateau");
    expect(html).toContain("$610.50");
    expect(html).toContain('href="https://scryfall.com/card/3ed/283"');
    expect(html).toContain("Revised Edition (3ED 283)");
    expect(html).toMatch(/price-kind proxy">Proxy</);
    expect(html).toMatch(/price-kind have">Real</);
    expect(html).toContain("Yours: SLD 1011, foil");
    // The figures: whole deck, proxies and real cards (nothing still needed, so no tab).
    expect(html).toContain("$611.75");
    expect(html).not.toContain("Still need");
    // One toggle a group, to leave lands (or anything else) out.
    expect(html).toContain(">Lands</button>");
    expect(html).toContain(">Artifacts</button>");
    expect(html.indexOf("Plateau")).toBeLessThan(html.indexOf("Sol Ring"));
  });
});
