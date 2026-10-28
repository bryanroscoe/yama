import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeckPrices, OwnershipValue } from "./DeckPrices";
import type { SinglesValue } from "../api";

const value: SinglesValue = { usd: 4.25, priced_copies: 31, unpriced_copies: 2, oldest_date: "2026-10-25", newest_date: "2026-10-26", source: "TCGplayer market via Scryfall" };

describe("deck market prices", () => {
  it("shows partial singles value with its contributing date range and separate sealed price", () => {
    const html = renderToStaticMarkup(<DeckPrices singles={value} precon sealed={{ product_id: 488296, product_name: "Riders of Rohan", usd: 81.13, price_date: "2026-10-26", source: "TCGplayer market via TCGCSV", url: "https://www.tcgplayer.com/product/488296" }} />);
    expect(html).toContain("$4.25");
    expect(html).toContain("partial: 2 copies without a price");
    expect(html).toContain("Oct 25 to Oct 26");
    expect(html).toContain("$81.13");
    expect(html).toContain("TCGplayer market via TCGCSV");
    expect(html).toContain("https://www.tcgplayer.com/product/488296");
  });

  it("keeps missing values unknown and custom decks free of sealed-product claims", () => {
    const html = renderToStaticMarkup(<DeckPrices singles={{ ...value, usd: null, priced_copies: 0, unpriced_copies: 100, oldest_date: null, newest_date: null }} />);
    expect(html).toContain("No price");
    expect(html).toContain("100 copies without a price");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("Sealed deck:");
    expect(renderToStaticMarkup(<DeckPrices singles={value} precon />)).toContain("no unambiguous product match");
  });

  it("splits the value into real cards, proxies and what's left, keeping missing prices unknown", () => {
    const html = renderToStaticMarkup(<OwnershipValue o={{ cards: 100, owned: 79, proxies: 10, needed: 11, needed_cost_usd: 286.4, needed_without_price: 1, owned_value_usd: 71.07, owned_without_price: 0, proxy_value_usd: 2004.5, proxies_without_price: 0 }} />);
    expect(html).toContain("Real cards you own");
    expect(html).toContain("$71.07");
    expect(html).toContain("$2004.50");
    expect(html).toContain("to replace 10 copies with real cards");
    expect(html).toContain("$286.40");
    expect(html).toContain("11 copies, basics excluded, 1 without a price");
    const done = renderToStaticMarkup(<OwnershipValue o={{ cards: 100, owned: 100, needed: 0, needed_cost_usd: 0, needed_without_price: 0 }} />);
    expect(done).not.toContain("Proxies");
    expect(done).toContain("No price");
    expect(done).toContain("Nothing");
  });
});

