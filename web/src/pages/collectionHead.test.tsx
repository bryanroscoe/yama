import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CollectionPage } from "./Collection";

vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));
vi.mock("../plan/outbox", () => ({ outbox: { localOps: () => [] }, useOutbox: () => ({}) }));

const summary = { copies: 40, proxies: 0, market_value_usd: 120, copies_without_price: 2, purchase_total_usd: 0, price_date: "2026-11-15" };
const box = (n: number) => ({ id: `b${n}`, kind: "box", name: `Box ${n}`, copies: 4, market_value_usd: 12, copies_without_price: 0, parent_id: null, path: [`Box ${n}`], depth: 0 });

function render(boxes: number, path = "/collection"): string {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "u1", email: "a@example.com", display_name: "A", power: false });
  client.setQueryData(["collection-summary"], summary);
  client.setQueryData(["containers"], Array.from({ length: boxes }, (_, i) => box(i + 1)));
  client.setQueryData(["decks"], []);
  client.setQueryData(["collection", "", "", "all"], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <CollectionPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the collection's head keeps the search near the top", () => {
  it("puts the search above the binders, boxes and decks", () => {
    const html = render(3);
    expect(html.indexOf("Search your collection by name")).toBeGreaterThan(0);
    expect(html.indexOf("Search your collection by name")).toBeLessThan(html.indexOf("Binders, boxes and decks"));
  });

  it("shows a few boxes as tiles", () => {
    const html = render(3);
    expect(html).toContain('class="container-tiles"');
    expect(html).not.toContain("coll-place");
    expect(html).toContain("Hide tiles");
    expect(html).toContain('aria-controls="coll-tiles"');
  });

  it("folds many boxes into a dropdown, with the tiles a tap away", () => {
    const html = render(12);
    expect(html).not.toContain('class="container-tiles"');
    expect(html).toMatch(/<select class="coll-place"[^>]*aria-label="Open a binder, box or deck"/);
    expect(html).toContain("Open one of 12");
    expect(html).toContain('<option value="b12">Box 12 (box)</option>');
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show tiles</);
    // The toggle names the tiles only while they are on the page.
    expect(html).not.toContain('aria-controls="coll-tiles"');
  });

  it("waits for the containers before drawing any tiles", () => {
    const client = new QueryClient();
    client.setQueryData(["me"], { id: "u1", email: "a@example.com", display_name: "A", power: false });
    client.setQueryData(["collection-summary"], summary);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/collection"]}>
          <CollectionPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toContain("Binders, boxes and decks");
    expect(html).toContain("Search your collection by name");
  });

  it("says the total in one line, with its date and unpriced cards", () => {
    const html = render(1);
    expect(html).toContain("40 cards, market value on Nov 15, 2 with no price");
  });
});
