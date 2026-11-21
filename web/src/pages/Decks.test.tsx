import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { DeckSummary } from "../api";
import { cardCount, collectsFrom, DecksPage, heroTitleSize, tileStatus } from "./Decks";

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
  it("lists every deck by name, each with its folder, and offers the tools once the list is long", () => {
    // Eight decks: enough that finding one takes more than a glance.
    const html = page("/decks", [...DECKS, ...["P", "Q", "R", "S", "T"].map((n) => deck(n))]);
    expect(tiles(html)).toEqual(["Atraxa Counters", "Krenko", "Omo Lands", "P", "Q", "R", "S", "T"]);
    expect(html).toContain('aria-label="Search decks by name or commander"');
    // On a phone everything but the search sits behind one button, closed until asked for.
    expect(html).toMatch(/<div class="deck-index-tools" role="search"/);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Filter and sort<\/button>/);
    // A filter already in the address starts it open, so what narrows the list is in sight.
    expect(page("/decks?colors=UG")).toMatch(/<div class="deck-index-tools is-open"/);
    expect(html).toContain(">In Precons</span>");
    expect(html).toContain(">In Brews</span>");
    for (const option of ["All folders", "Brews", "Precons", "No folder", "Any", "3, Upgraded", "None declared"]) {
      expect(html).toContain(`>${option}</option>`);
    }
    // The sort is three choices: one pill track, name pressed.
    expect(html).toMatch(/aria-pressed="true"[^>]*>Name<\/button>/);
    for (const sort of ["Recently changed", "Record"]) expect(html).toMatch(new RegExp(`aria-pressed="false"[^>]*>${sort}</button>`));
    expect(html).toContain("Search 8 decks by name or commander");
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

  it("keeps the folder the address names as the choice, even when no deck is in it any more", () => {
    const html = page("/decks?folder=Old+brews");
    expect(tiles(html)).toEqual([]);
    expect(html).toMatch(/<option value="Old brews" selected="">Old brews<\/option>/);
    expect(html).toContain("0 of 3 decks");
    // With no folders at all, the picker still shows while a folder filters the list.
    const none = page("/decks?folder=Gone", DECKS.map((d) => ({ ...d, folder: null })));
    expect(none).toMatch(/<option value="Gone" selected="">Gone<\/option>/);
  });

  it("shows every tile's record, at any width, while sorted by record", () => {
    expect(page("/decks?sort=record")).toContain('class="deck-tiles by-record"');
    expect(page("/decks")).toContain('class="deck-tiles"');
  });

  it("waits for the list before offering to search it", () => {
    const client = new QueryClient();
    client.setQueryData(["me"], { id: "u1" });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/decks?q=omo"]}>
          <DecksPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toContain("Search decks by name or commander");
    expect(html).not.toContain("0 of 0");
  });

  it("says when nothing matches, with a way back to every deck", () => {
    const html = page("/decks?q=zzz");
    expect(tiles(html)).toEqual([]);
    expect(html).toContain("No decks match.");
    expect(html).not.toContain("No decks yet.");
    expect(html).toContain("0 of 3 decks");
  });

  it("has no tools for a short list, and lists a deck's other lists under their main deck only", () => {
    const one = page("/decks", [DECKS[0]!, deck("Omo budget", { parent_id: "Omo Lands", configuration: "Budget" })]);
    expect(tiles(one)).toEqual(["Omo Lands"]);
    expect(one).not.toContain("Search decks by name or commander");
    // A few decks are all on screen already.
    expect(page("/decks")).not.toContain("Search decks by name or commander");
  });

  it("names the commander on every tile and says where the prices come from once, under the grid", () => {
    const value = { usd: 61.32, priced_copies: 100, unpriced_copies: 0, oldest_date: "2026-11-19", newest_date: "2026-11-20", source: "TCGplayer market via Scryfall" };
    const html = page("/decks", [deck("Krenko", { commanders: ["Krenko, Mob Boss"], singles_value: value }), deck("Omo", { singles_value: { ...value, usd: 12, unpriced_copies: 2 } })]);
    expect(html).toContain(">Krenko, Mob Boss</span>");
    expect(html).toContain("<b>$61.32</b>");
    expect(html).toContain("<b>$12.00</b>, partial");
    expect(html.match(/TCGplayer market via Scryfall/g)).toHaveLength(1);
    expect(html).toContain("Deck prices are what the singles cost: TCGplayer market via Scryfall, Nov 19 to Nov 20. Partial means some cards have no price.");
  });
});

describe("what a deck's tile says first", () => {
  const d = { acquisition_status: null, format: "commander", card_count: 100, owned: 0, proxies: 0 } as const;
  it("says how far along an unfinished list is, not how many cards it needs", () => {
    expect(tileStatus({ ...d, card_count: 4 }, true)).toEqual({ text: "4 of 100 cards", short: "4 of 100 cards", tone: "bad" });
    expect(tileStatus({ ...d, card_count: 4 }, false).tone).toBe("bad");
  });
  it("says nothing about owning cards to an account that keeps no collection", () => {
    expect(tileStatus(d, false)).toEqual({ text: "100 cards", short: "100 cards", tone: null });
    expect(tileStatus(d, true)).toMatchObject({ short: "Need 100", tone: "warn" });
    expect(tileStatus({ ...d, owned: 90, proxies: 10 }, true)).toMatchObject({ text: "90 real, 10 proxies", short: "Complete", tone: "good" });
    expect(tileStatus({ ...d, acquisition_status: "planned" }, true).text).toBe("Planned deck");
  });
  it("steps a long name's hero title down", () => {
    expect(heroTitleSize("Riders of Rohan")).toBe("");
    expect(heroTitleSize("Riders of Rohan, competitive combat (proposed)")).toBe(" is-long");
    expect(heroTitleSize("x".repeat(111))).toBe(" is-longer");
  });
});

describe("whether the account keeps a collection", () => {
  const owns = (copies: number, proxies = 0) => ({ data: { copies, proxies }, isError: false });
  it("is the collection summary's answer once it has one, whatever the decks say", () => {
    expect(collectsFrom(owns(0), true)).toBe(false);
    expect(collectsFrom(owns(3), false)).toBe(true);
    expect(collectsFrom(owns(0, 2), false)).toBe(true);
  });
  it("is what the decks on screen say while the summary loads", () => {
    expect(collectsFrom({ isError: false }, true)).toBe(true);
    expect(collectsFrom({ isError: false }, false)).toBe(false);
  });
  it("is never 'owns nothing' because the summary failed to load", () => {
    expect(collectsFrom({ isError: true }, false)).toBe(true);
    // A refresh that failed keeps the answer it had.
    expect(collectsFrom({ ...owns(0), isError: true }, true)).toBe(false);
  });
});
