import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { DeckSummary } from "../api";
import { cardCount, DecksPage } from "./Decks";

vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));
vi.mock("../plan/outbox", () => ({ outbox: { localOps: () => [] }, useOutbox: () => ({}) }));

describe("the deck list", () => {
  it("counts one card as a card", () => {
    expect(cardCount(1)).toBe("1 card");
    expect(cardCount(0)).toBe("0 cards");
    expect(cardCount(100)).toBe("100 cards");
  });
});

const deck = (name: string, over: Partial<DeckSummary> = {}): DeckSummary => ({
  id: name, name, folder: null, format: "commander", container_id: null, current_version_id: "v", updated_at: "2026-01-01T00:00:00Z",
  commanders: [], color_identity: "", card_count: 100, commander_image: null, commander_artist: null, games: 0, wins: 0, draws: 0,
  bracket: null, estimate: null, parent_id: null, configuration: null, visibility: "private", share_token: null, ...over,
});
const DECKS = [
  deck("Omo Lands", { folder: "Brews", commanders: ["Omo, Queen of Vesuva"], color_identity: "GU", bracket: 3, games: 4, wins: 3 }),
  deck("Atraxa Counters", { folder: "Precons", commanders: ["Atraxa, Praetors' Voice"], color_identity: "WUBG", games: 10, wins: 5 }),
  deck("Krenko", { commanders: ["Krenko, Mob Boss"], color_identity: "R" }),
];

function page(path: string, decks: DeckSummary[] = DECKS): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["me"], { id: "u1" });
  client.setQueryData(["decks"], decks);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <DecksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
/** The deck names on the tiles, in order. */
const tiles = (html: string) => [...html.matchAll(/class="deck-tile-name">([^<]+)</g)].map((m) => m[1]);

describe("finding a deck on the Decks list", () => {
  it("lists every deck by name, each with its folder, and offers the tools", () => {
    const html = page("/decks");
    expect(tiles(html)).toEqual(["Atraxa Counters", "Krenko", "Omo Lands"]);
    expect(html).toContain('aria-label="Search decks by name or commander"');
    expect(html).toContain(">In Precons</span>");
    expect(html).toContain(">In Brews</span>");
    for (const option of ["All folders", "Brews", "Precons", "No folder", "Any bracket", "3, Upgraded", "No bracket yet", "Recently changed", "Record"]) {
      expect(html).toContain(`>${option}</option>`);
    }
    for (const color of ["White", "Blue", "Black", "Red", "Green"]) expect(html).toContain(`aria-label="${color}"`);
    // Nothing is narrowed, so there is no count and nothing to clear.
    expect(html).not.toContain("Clear filters");
  });

  it("shows one folder's decks, without repeating the folder on each tile", () => {
    const html = page("/decks?folder=Precons");
    expect(tiles(html)).toEqual(["Atraxa Counters"]);
    expect(html).not.toContain(">In Precons</span>");
    expect(html).toContain("1 of 3 decks");
    expect(html).toContain(">Clear filters</button>");
  });

  it("searches by commander, filters by color and bracket, and sorts by record", () => {
    expect(tiles(page("/decks?q=mob+boss"))).toEqual(["Krenko"]);
    expect(tiles(page("/decks?colors=UG"))).toEqual(["Atraxa Counters", "Omo Lands"]);
    expect(tiles(page("/decks?bracket=3"))).toEqual(["Omo Lands"]);
    expect(tiles(page("/decks?folder="))).toEqual(["Krenko"]);
    expect(tiles(page("/decks?sort=record"))).toEqual(["Omo Lands", "Atraxa Counters", "Krenko"]);
    expect(page("/decks?colors=UG")).toMatch(/aria-pressed="true"[^>]*aria-label="Blue"/);
  });

  it("says when nothing matches, with a way back to every deck", () => {
    const html = page("/decks?q=zzz");
    expect(tiles(html)).toEqual([]);
    expect(html).toContain("No decks match.");
    expect(html).not.toContain("No decks yet.");
    expect(html).toContain("0 of 3 decks");
  });

  it("has no tools for a single deck, and lists a deck's other lists under their main deck only", () => {
    const one = page("/decks", [DECKS[0]!, deck("Omo budget", { parent_id: "Omo Lands", configuration: "Budget" })]);
    expect(tiles(one)).toEqual(["Omo Lands"]);
    expect(one).not.toContain("Search decks by name or commander");
  });
});
