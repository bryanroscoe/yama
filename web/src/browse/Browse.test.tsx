import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { BrowsePage, type ListedDeck, type Listing } from "./Browse";
import { apiQuery, readFilter } from "./filter";

const deck = (over: Partial<ListedDeck>): ListedDeck => ({
  token: "abc123",
  name: "Counters matter",
  handle: "ann",
  commanders: ["Atraxa, Praetors' Voice"],
  color_identity: "WUBG",
  art: { url: "https://cards.scryfall.io/art/atraxa.jpg", artist: "Victor Adame Minguez", card: "Atraxa, Praetors' Voice" },
  bracket: 3,
  card_count: 100,
  updated_at: "2026-11-10T00:00:00Z",
  precon: null,
  ...over,
});

function page(listing: Listing | undefined, address = "/decks/browse", me: object | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, enabled: false } } });
  client.setQueryData(["me"], me);
  const search = address.includes("?") ? address.slice(address.indexOf("?")) : "";
  if (listing) client.setQueryData(["browse", apiQuery(readFilter(new URLSearchParams(search)))], listing);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[address]}>
        <BrowsePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("Browse", () => {
  it("shows each public deck as a tile that opens its shared page, with a way to save a copy", () => {
    const html = page({
      decks: [deck({}), deck({ token: "def456", name: "Goblins", handle: "bob", commanders: ["Krenko, Mob Boss"], color_identity: "R", art: null, bracket: null, precon: { id: "goblin-precon", name: "Goblin Precon" } })],
      page: 0,
      pages: 1,
      total: 2,
    });
    // The shared page is the server's, so the tile is a document link.
    expect(html).toContain('<a href="/d/abc123" class="deck-tile">');
    expect(html).toContain("Counters matter");
    expect(html).toContain("Atraxa, Praetors&#x27; Voice");
    expect(html).toContain("By @ann");
    expect(html).toContain("100 cards");
    expect(html).toContain("Started from Goblin Precon");
    expect(html).toContain('href="/decks/import?shared=def456"');
    expect(html).toContain('aria-label="Save a copy of Goblins"');
    expect(html).toContain("2 public decks");
    // Art carries its artist's credit in the same view; a tile without art adds none.
    expect(html).toContain("Art by Victor Adame Minguez.");
    // One page: no pager.
    expect(html).not.toContain("Pages of decks");
  });

  it("is open to someone signed out", () => {
    const out = page({ decks: [deck({})], page: 0, pages: 1, total: 1 });
    expect(out).toContain("Browse decks");
    expect(out).toContain('<a href="/d/abc123" class="deck-tile">');
  });

  it("reads the filters from the address and offers pages when there are more", () => {
    const html = page({ decks: [deck({ precon: { id: "goblin-precon", name: "Goblin Precon" } })], page: 1, pages: 3, total: 60 }, "/decks/browse?q=gob&colors=RG&bracket=2&precon=goblin-precon&page=2");
    expect(html).toContain('value="gob"');
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Red"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="White"/);
    expect(html).toContain("Started from Goblin Precon</label>");
    expect(html).toContain("60 decks match");
    expect(html).toContain("Clear filters");
    expect(html).toContain('aria-label="Pages of decks"');
    expect(html).toContain("Page 2 of 3");
  });

  it("says which kind of nothing: no public decks yet, or none that match", () => {
    const empty = { decks: [], page: 0, pages: 1, total: 0 };
    expect(page(empty)).toContain("No public decks yet.");
    const none = page(empty, "/decks/browse?commander=nobody");
    expect(none).toContain("No decks match.");
    expect(none).not.toContain("No public decks yet.");
  });
});
