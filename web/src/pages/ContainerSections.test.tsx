import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Container } from "../api";
import { CollectionPage } from "./Collection";
import { sectionMeta } from "./ContainerSections";

const box = (over: Partial<Container> & Pick<Container, "id" | "name">): Container => ({ kind: "box", copies: 0, market_value_usd: 0, copies_without_price: 0, parent_id: null, sections: 0, ...over });

// The server's tree order: each box followed by its sections.
const boxes: Container[] = [
  box({ id: "big", name: "Big box", copies: 2, sections: 2, total_copies: 312, total_market_value_usd: 140, path: ["Big box"] }),
  box({ id: "bb", name: "Bulk Basic", parent_id: "big", copies: 10, sections: 1, total_copies: 300, total_market_value_usd: 30, path: ["Big box", "Bulk Basic"], depth: 1 }),
  box({ id: "pl", name: "Plains", parent_id: "bb", copies: 290, total_copies: 290, total_market_value_usd: 29, path: ["Big box", "Bulk Basic", "Plains"], depth: 2 }),
  box({ id: "red", name: "Bulk Red", parent_id: "big", copies: 10, total_copies: 10, total_market_value_usd: 5, path: ["Big box", "Bulk Red"], depth: 1 }),
  box({ id: "trade", name: "Trade binder", kind: "binder", copies: 4, total_copies: 4, total_market_value_usd: 20, path: ["Trade binder"] }),
];

function render(path: string) {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "u1", email: "me@example.com", display_name: "Me", power: false });
  client.setQueryData(["collection-summary"], { copies: 316, proxies: 0, distinct_printings: 9, market_value_usd: 160, copies_without_price: 0, price_date: "2026-11-10", purchase_total_usd: 0, copies_without_purchase_price: 0, copies_paid_in_other_currency: 0 });
  client.setQueryData(["containers"], boxes);
  client.setQueryData(["decks"], []);
  client.setQueryData(["collection", "", "", "all"], []);
  client.setQueryData(["collection", "bb", "", "all"], []);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}><CollectionPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("sections on the Collection page", () => {
  it("shows only top-level boxes as tiles, with everything inside counted", () => {
    const html = render("/collection");
    const tiles = html.slice(html.indexOf("container-tiles"), html.indexOf("</ul>", html.indexOf("container-tiles")));
    expect(tiles).toContain("Big box");
    expect(tiles).toContain("Trade binder");
    expect(tiles).not.toContain("Bulk Basic");
    expect(tiles).toContain("312 cards, $140, 2 sections");
    // Nothing is loose: the own copies add up to the collection, totals aren't counted twice.
    expect(tiles).not.toContain("Loose cards");
  });

  it("opens a section with its path, its own sections and what can be done with it", () => {
    const html = render("/collection?box=bb");
    expect(html).toContain('aria-label="Where it sits"');
    expect(html).toMatch(/>Big box<\/button>/);
    expect(html).toContain('aria-current="page">Bulk Basic<');
    expect(html).toContain("Plains");
    expect(html).toContain('href="/collection/check/bb"');
    expect(html).toContain("Scan this section");
    // One primary action; New section, Rename, Move and Delete wait behind More.
    expect(html).toMatch(/<div class="more-menu"><button[^>]*aria-expanded="false"[^>]*>More</);
    for (const label of ["New section", "Rename", "Move", "Delete section"]) expect(html).not.toContain(`>${label}<`);
    // The box is the page: its name is the heading, and the collection's own head is gone.
    expect(html).toContain('<h1 class="ct-name">Bulk Basic</h1>');
    expect(html).not.toContain(">Collection</h1>");
    expect(html).not.toContain(">Scan cards<");
    expect(html).toContain("Include its sections");
  });

  it("says a section's own and rolled-up cards", () => {
    expect(sectionMeta(boxes[1]!)).toBe("10 cards here, 300 in all, $30.00");
    expect(sectionMeta(boxes[2]!)).toBe("290 cards, $29.00");
    // Nothing in it: "Empty", never "0 cards, $0".
    expect(sectionMeta(box({ id: "e", name: "New" }))).toBe("Empty");
    expect(sectionMeta(box({ id: "p", name: "Parent", sections: 1, total_copies: 12, total_market_value_usd: 140 }))).toBe("12 cards in its sections, $140");
    // Cards with no price are counted, and no value is printed for them.
    expect(sectionMeta(box({ id: "u", name: "Unpriced", copies: 3, total_copies: 3 }))).toBe("3 cards");
  });
});

describe("a container's kind on its scan button", () => {
  const scan = (c: Container) => {
    const client = new QueryClient();
    client.setQueryData(["collection-summary"], { copies: 4, proxies: 0, distinct_printings: 1, market_value_usd: 20, copies_without_price: 0, price_date: "2026-11-10", purchase_total_usd: 0 });
    client.setQueryData(["containers"], [c]);
    client.setQueryData(["decks"], []);
    client.setQueryData(["collection", c.id, "", "all"], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/collection?box=${c.id}`]}><CollectionPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    client.clear();
    return html;
  };
  it("names what is scanned: a binder, a deck box, a box", () => {
    expect(scan(box({ id: "t", name: "Trade", kind: "binder", copies: 4 }))).toContain(">Scan this binder<");
    expect(scan(box({ id: "d", name: "Atraxa", kind: "deck", copies: 4 }))).toContain(">Scan this deck box<");
    expect(scan(box({ id: "b", name: "Bulk", copies: 4 }))).toContain(">Scan this box<");
  });
});
