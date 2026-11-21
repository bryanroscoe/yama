import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usdWhole } from "@yama/core";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CollectionItem } from "../api";
import { CollectionPage, tileMeta } from "./Collection";
import { CollectionGrid } from "./CollectionGrid";
import { activeFilters, byValue, cardsAndProxies, clampFilters, filterOptions, foundText, money, NO_FILTERS, passes, totals, totalsText } from "./collectionFilters";

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
    const marked = item({ name: "Mount Doom", lang: "ja", signed: true, altered: true });
    const html = renderToStaticMarkup(<CollectionGrid items={[ring, atraxa, bolt, dryad, marked]} onOpen={() => undefined} />);
    // What makes a copy its own beside another of the same printing is said under it.
    for (const tag of ["Japanese", "Signed", "Altered"]) expect(html).toContain(`>${tag}<`);
    // The normal-size image from Scryfall, untouched: no style or filter on it, nothing inside the button but the image.
    expect(html).toContain('src="https://cards.scryfall.io/normal/1.jpg"');
    expect(html).not.toMatch(/<img[^>]*style=/);
    expect(html).toMatch(/<button type="button" class="coll-tile" aria-label="Sol Ring, 2 copies"><img [^>]*><\/button>/);
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

  it("opens a box on its own, with the way back, instead of only filtering under the tiles", () => {
    const boxes = [
      { id: "b1", kind: "binder", name: "Trade binder", copies: 4, market_value_usd: 20, copies_without_price: 0 },
      { id: "b2", kind: "box", name: "Bulk box", copies: 2, market_value_usd: 1, copies_without_price: 0 },
    ];
    const render = (path: string) => {
      const client = new QueryClient();
      client.setQueryData(["me"], { id: "u1", email: "me@example.com", display_name: "Me", power: false });
      client.setQueryData(["collection-summary"], { copies: 6, proxies: 0, distinct_printings: 5, market_value_usd: 21, copies_without_price: 0, price_date: "2026-11-10", purchase_total_usd: 0, copies_without_purchase_price: 6, copies_paid_in_other_currency: 0 });
      client.setQueryData(["containers"], boxes);
      client.setQueryData(["decks"], []);
      client.setQueryData(["collection", "", "", "all"], all);
      client.setQueryData(["collection", "b1", "", "all"], all.slice(0, 2));
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}><CollectionPage /></MemoryRouter>
        </QueryClientProvider>,
      );
      client.clear();
      return html;
    };
    const every = render("/collection");
    expect(every).toContain("container-tiles");
    expect(every).toContain("Bulk box");
    const open = render("/collection?box=b1");
    expect(open).not.toContain("container-tiles");
    expect(open).not.toContain("Bulk box");
    expect(open).toMatch(/<h1 class="ct-name">Trade binder<\/h1>/);
    expect(open).toContain('aria-label="Back to every binder, box and deck"');
    expect(open).toContain(">Scan this binder<");
    expect(render("/collection?box=gone")).toContain("No such binder or box");
  });
});

describe("the by-value order, counts and totals", () => {
  it("puts proxies after priced real cards: their price is the real card's, not theirs", () => {
    const cradle = item({ name: "Gaea's Cradle", proxy: true, unit_price_usd: 1653.09 });
    const order = [cradle, bolt, ring, atraxa, dryad].sort(byValue).map((i) => i.name);
    // Real cards by price, then proxies by what the real card costs, then cards with no price.
    expect(order).toEqual(["Atraxa, Praetors' Voice", "Sol Ring", "Gaea's Cradle", "Dryad Arbor", "Lightning Bolt"]);
  });

  it("shows a proxy's price as the real copy's, in the list and in pictures", () => {
    const cradle = item({ name: "Gaea's Cradle", proxy: true, unit_price_usd: 1653.09 });
    const html = renderToStaticMarkup(<CollectionGrid items={[cradle, ring]} onOpen={() => undefined} />);
    expect(html).toMatch(/coll-real-price"><span>real copy<\/span> <span class="num">\$1,653\.09<\/span>/);
    expect(html).toContain('<span class="coll-tile-price num">$1.50</span>');
    // A proxy of a card with no price shows no price at all.
    const none = renderToStaticMarkup(<CollectionGrid items={[item({ name: "Odd", proxy: true, unit_price_usd: null })]} onOpen={() => undefined} />);
    expect(none).not.toContain("No price");
    expect(none).not.toContain("real copy");
  });

  it("counts real cards and proxies apart, the same way in the head and on a tile", () => {
    expect(cardsAndProxies(6, 1)).toBe("5 cards and 1 proxy");
    expect(cardsAndProxies(40)).toBe("40 cards");
    expect(cardsAndProxies(3, 3)).toBe("3 proxies");
    expect(cardsAndProxies(0)).toBe("Empty");
    expect(tileMeta(6, 1, 4.5, 2)).toBe("5 cards and 1 proxy, $4.50, 2 with no price");
    expect(tileMeta(146, 0, 402.4, 0)).toBe("146 cards, $402");
    // Nothing in it, or nothing with a price: no "$0".
    expect(tileMeta(0, 0, 0, 0)).toBe("Empty");
    expect(tileMeta(3, undefined, 0, 3)).toBe("3 cards, 3 with no price");
  });

  it("shows cents while a total is small", () => {
    expect(money(4.5)).toBe("$4.50");
    expect(money(99.99)).toBe("$99.99");
    expect(money(100)).toBe("$100");
    expect(money(1768.6)).toBe("$1,769");
  });

  it("says what a search found", () => {
    expect(foundText(15, "sol ring")).toBe("15 cards called “sol ring”");
    expect(foundText(1, "bolt", "Trade binder")).toBe("1 card called “bolt” in Trade binder");
  });
});

describe("the Collection page with nothing in it", () => {
  const render = (boxes: unknown[]) => {
    const client = new QueryClient();
    client.setQueryData(["me"], { id: "u1", email: "me@example.com", display_name: "Me", power: false });
    client.setQueryData(["collection-summary"], { copies: 0, proxies: 0, distinct_printings: 0, market_value_usd: 0, copies_without_price: 0, price_date: null, purchase_total_usd: 0 });
    client.setQueryData(["containers"], boxes);
    client.setQueryData(["decks"], []);
    client.setQueryData(["collection", "", "", "all"], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/collection"]}><CollectionPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    client.clear();
    return html;
  };
  it("is only its empty state: what the collection is for and the three ways to start", () => {
    const html = render([]);
    expect(html).toContain("Keep track of the cards you own");
    for (const label of ["Scan cards", "Import a list", "Add from card search"]) expect(html.split(`>${label}<`)).toHaveLength(2);
    for (const gone of ["Most valuable", "By value", "Export CSV", "Search your collection", "$0", "No cards yet", "Where they live"]) expect(html).not.toContain(gone);
    expect(html).toContain("Make a binder, box or deck");
  });
  it("still shows a box made before any card, as empty", () => {
    const html = render([{ id: "b1", kind: "box", name: "Bulk", copies: 0, market_value_usd: 0, copies_without_price: 0 }]);
    expect(html).toContain("container-tiles");
    expect(html).toMatch(/<span class="ct-meta num">Empty<\/span>/);
    expect(html).not.toContain("$0");
  });
});
