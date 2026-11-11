import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usdWhole } from "@yama/core";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CollectionItem } from "../api";
import { CollectionPage } from "./Collection";
import { CollectionGrid } from "./CollectionGrid";
import { activeFilters, clampFilters, filterOptions, NO_FILTERS, passes, totals, totalsText } from "./collectionFilters";

let n = 0;
function item(over: Partial<CollectionItem> & { name: string }): CollectionItem {
  n += 1;
  return {
    id: `i${n}`, scryfall_id: `p${n}`, qty: 1, condition: "NM", finish: "nonfoil", lang: "en", proxy: false, container_id: null, container_name: null, container_kind: null,
    purchase_price: null, oracle_id: `o${n}`, set_code: "cmm", set_name: "Commander Masters", collector_number: "1", rarity: "rare",
    image_small: `https://cards.scryfall.io/small/${n}.jpg`, image_normal: `https://cards.scryfall.io/normal/${n}.jpg`, type_line: "Artifact", color_identity: "", unit_price_usd: 1, price_date: "2026-11-10", ...over,
  };
}

const ring = item({ name: "Sol Ring", rarity: "uncommon", unit_price_usd: 1.5, qty: 2 });
const atraxa = item({ name: "Atraxa, Praetors' Voice", type_line: "Legendary Creature — Phyrexian Angel Horror", color_identity: "WUBG", rarity: "mythic", finish: "foil", unit_price_usd: 30 });
const bolt = item({ name: "Lightning Bolt", type_line: "Instant", color_identity: "R", rarity: "common", set_code: "lea", set_name: "Limited Edition Alpha", unit_price_usd: null });
const dryad = item({ name: "Dryad Arbor", type_line: "Land Creature — Forest Dryad", color_identity: "G", rarity: "rare", finish: "etched", proxy: true, unit_price_usd: 9 });
const unknown = item({ name: "?", oracle_id: null, set_code: null, set_name: null, rarity: null, type_line: null, color_identity: null, unit_price_usd: null });
const all = [ring, atraxa, bolt, dryad, unknown];
const names = (f: Partial<typeof NO_FILTERS>) => all.filter((i) => passes(i, { ...NO_FILTERS, ...f })).map((i) => i.name);

describe("collection filters", () => {
  it("filters by set, color, type, rarity and finish, alone and together", () => {
    expect(names({})).toHaveLength(5);
    expect(names({ set: "lea" })).toEqual(["Lightning Bolt"]);
    // A color is in the card's color identity; colorless and multicolor are their own choices.
    expect(names({ color: "G" })).toEqual(["Atraxa, Praetors' Voice", "Dryad Arbor"]);
    expect(names({ color: "C" })).toEqual(["Sol Ring"]);
    expect(names({ color: "M" })).toEqual(["Atraxa, Praetors' Voice"]);
    // A card of two types is found by either.
    expect(names({ type: "Creature" })).toEqual(["Atraxa, Praetors' Voice", "Dryad Arbor"]);
    expect(names({ type: "Land" })).toEqual(["Dryad Arbor"]);
    expect(names({ rarity: "rare" })).toEqual(["Dryad Arbor"]);
    expect(names({ finish: "foil" })).toEqual(["Atraxa, Praetors' Voice"]);
    expect(names({ color: "G", type: "Creature", finish: "etched" })).toEqual(["Dryad Arbor"]);
    expect(names({ set: "cmm", rarity: "common" })).toEqual([]);
    // A printing Yama doesn't know passes no card filter, and still shows with none set.
    expect(names({ color: "C" })).not.toContain("?");
    expect(names({ finish: "nonfoil" })).toContain("?");
    expect(activeFilters(NO_FILTERS)).toBe(0);
    expect(activeFilters({ ...NO_FILTERS, set: "lea", finish: "foil" })).toBe(2);
  });

  it("offers only what the rows in view hold, and drops a choice they no longer hold", () => {
    const o = filterOptions(all);
    expect(o.sets).toEqual([{ code: "cmm", name: "Commander Masters" }, { code: "lea", name: "Limited Edition Alpha" }]);
    expect(o.types).toEqual(["Creature", "Instant", "Artifact", "Land"]);
    expect(o.rarities).toEqual(["common", "uncommon", "rare", "mythic"]);
    expect(o.finishes).toEqual(["nonfoil", "foil", "etched"]);
    const box = filterOptions([ring]);
    expect(clampFilters({ set: "lea", color: "R", type: "Instant", rarity: "uncommon", finish: "foil" }, box)).toEqual({ set: "", color: "R", type: "", rarity: "uncommon", finish: "" });
  });

  it("adds up what is left: proxies and copies with no price are counted, never as $0", () => {
    expect(totals(all)).toEqual({ copies: 6, proxies: 1, value: 33, unpriced: 2 });
    expect(totalsText(totals(all), usdWhole)).toBe("6 cards match, $33 market value. 2 have no price and aren't counted. 1 proxy isn't counted.");
    expect(totalsText(totals([ring]), usdWhole)).toBe("2 cards match, $3 market value.");
    // Nothing priced: no dollar figure at all, rather than $0.
    expect(totalsText(totals([bolt]), usdWhole)).toBe("1 card matches. 1 has no price and isn't counted.");
    expect(totalsText(totals([dryad]), usdWhole)).toBe("1 card matches. 1 proxy isn't counted.");
  });
});

describe("the collection as pictures", () => {
  it("shows each row's own printing whole, with copies, finish and price under it", () => {
    const html = renderToStaticMarkup(<CollectionGrid items={[ring, atraxa, bolt, dryad]} onOpen={() => undefined} />);
    // The normal-size image from Scryfall, untouched: no style or filter on it, nothing inside the button but the image.
    expect(html).toContain('src="https://cards.scryfall.io/normal/1.jpg"');
    expect(html).not.toMatch(/<img[^>]*style=/);
    expect(html).toMatch(/<button class="coll-tile" aria-label="Sol Ring, 2 copies"><img [^>]*><\/button>/);
    expect(html).toContain("×2");
    expect(html).toContain(">Foil<");
    expect(html).toContain(">Etched<");
    expect(html).toContain(">Proxy<");
    expect(html).toContain("$30.00");
    // No price is said, not shown as $0.
    expect(html).toContain("No price");
    expect(html).not.toContain("$0");
  });
});

describe("the Collection page", () => {
  it("offers the filters and the list or pictures choice once there are cards", () => {
    const client = new QueryClient();
    client.setQueryData(["me"], { id: "u1", email: "me@example.com", display_name: "Me", power: false });
    client.setQueryData(["collection-summary"], { copies: 6, proxies: 1, distinct_printings: 5, market_value_usd: 33, copies_without_price: 2, price_date: "2026-11-10", purchase_total_usd: 0, copies_without_purchase_price: 5, copies_paid_in_other_currency: 0 });
    client.setQueryData(["containers"], []);
    client.setQueryData(["decks"], []);
    client.setQueryData(["collection", "", "", "all"], all);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/collection"]}><CollectionPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    for (const label of ["Set", "Color", "Card type", "Rarity", "Finish"]) expect(html).toContain(`<select aria-label="${label}"`);
    expect(html).toContain("Commander Masters (CMM)");
    expect(html).toContain(">Multicolor<");
    expect(html).toContain(">Etched<");
    expect(html).toMatch(/>List<\/button>/);
    expect(html).toMatch(/>Pictures<\/button>/);
    // Nothing is filtered yet: no totals line and nothing to clear.
    expect(html).not.toContain("Clear filters");
    expect(html).not.toContain("cards match");
    client.clear();
  });
});
