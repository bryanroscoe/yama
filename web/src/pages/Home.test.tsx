import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeckSummary, GameRow } from "../api";
import { HOME_LINKS, HomePage } from "./Home";
import { startSteps } from "./StartHere";

const table = vi.hoisted(() => ({ game: null as unknown, state: null as unknown, opening: false, recent: true }));
vi.mock("../table/store", () => ({ useTable: () => ({ game: table.game, state: table.state }), usePendingDeletes: () => ["deleted"] }));
vi.mock("../table/resume", () => ({ isOpening: () => table.opening, opened: () => {}, resumesOnOpen: () => table.recent }));
vi.mock("../components/useCardArt", () => ({ useCardArt: () => new Map() }));
vi.mock("../table/SharedTables", () => ({ SharedTables: () => <p>Shared tables</p> }));
// A redirect draws nothing in a static render: show where it goes.
vi.mock("react-router", async (original) => ({ ...(await original<typeof import("react-router")>()), Navigate: ({ to }: { to: string }) => <p>Goes to {to}</p> }));

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(table, { game: null, state: null, opening: false, recent: true });
});

const deck = (id: string, more: Partial<DeckSummary> = {}) => ({ id, name: `Deck ${id}`, updated_at: "2026-11-01T00:00:00Z", commanders: [], commander_image: null, commander_artist: null, parent_id: null, ...more }) as DeckSummary;
const game = (id: string, more: Partial<GameRow> = {}) => ({
  id, mode: "in_person", status: "finished", started_at: "2026-10-31T01:00:00Z", winner_seat: 0,
  seats: [{ seat: 0, display_name: "Kelly", commander_name: "Atraxa" }, { seat: 1, display_name: "Pat" }], ...more,
}) as GameRow;

// An account that has finished Start here, unless a test says otherwise: `copies` in its
// collection and `groups` playgroups (null: that answer hasn't arrived).
function home({ me = { id: "u1" } as { id: string } | null, decks = [] as DeckSummary[], games = [] as GameRow[], copies = 5 as number | null, groups = 1 as number | null } = {}) {
  vi.stubGlobal("location", { origin: "https://yama.ing" });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], me);
  client.setQueryData(["decks"], decks);
  client.setQueryData(["games"], games);
  if (copies !== null) client.setQueryData(["collection-summary"], { copies });
  if (groups !== null) client.setQueryData(["playgroups"], Array.from({ length: groups }, (_, i) => ({ id: `p${i}` })));
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");
const going = { game: { setup: { startedAt: "2026-11-12T01:00:00Z" }, log: [] }, state: { finished: false, turn: 3, activeSeat: 0, setup: { format: "commander" }, players: [{ seat: 0, name: "Kelly" }] } };

describe("Home, signed out", () => {
  it("says what Yama is and lists what works without an account, with the way in", () => {
    const html = home({ me: null });
    expect(html).toContain("<h1>Commander, at your table.</h1>");
    expect(html).toContain("free Magic: The Gathering app for Commander players");
    expect(html).toContain('href="/signin"');
    expect(html).toContain("No account needed");
    expect(HOME_LINKS.map((l) => l.to)).toEqual(["/check", "/play/table", "/play", "/decks/browse", "/precons", "/commanders", "/cards"]);
    // The server's own pages are document links; the app's are routes.
    expect(hrefs(html)).toEqual(["/signin", "/check", "/play/table", "/play", "/decks/browse", "https://yama.ing/precons", "https://yama.ing/commanders", "/cards"]);
  });

  it("shows nothing of an account's: no decks, games or shared tables", () => {
    const html = home({ me: null, decks: [deck("a")], games: [game("g1")] });
    for (const text of ["Deck a", "Kelly", "Your recent decks", "Game in progress", "latest games", "Shared tables"]) expect(html).not.toContain(text);
  });

  it("offers the way back to a game counted here without an account, as the one primary action", () => {
    Object.assign(table, going);
    const html = home({ me: null });
    expect(html).toMatch(/<a class="button primary"[^>]*href="\/table\/play"[^>]*>Back to the table<\/a>/);
    expect(html).toMatch(/<a class="button outline"[^>]*href="\/signin"[^>]*>Sign in<\/a>/);
    expect(html.match(/class="button primary"/g)).toHaveLength(1);
  });
});

describe("Home, signed in", () => {
  it("offers starting a game, your recent decks and your playgroup's latest games", () => {
    const html = home({ decks: [deck("a")], games: [game("g1")] });
    expect(html).toContain("<h1>Home</h1>");
    for (const title of ["Start a game", "Your recent decks", "Your latest games", "Shared tables"]) expect(html).toContain(title);
    expect(html).toMatch(/<a class="button primary"[^>]*href="\/play\/table"[^>]*>Count life at the table<\/a>/);
    for (const path of ["/play", "/decks/a", "/decks", "/table/games/g1", "/table/games", "/group"]) expect(html).toContain(`href="${path}"`);
    // Nothing is waiting or failing, so nothing says so.
    for (const text of ["Loading", "can be reached", 'role="alert"']) expect(html).not.toContain(text);
    expect(html).not.toContain("Game in progress");
    expect(html).not.toContain("No account needed");
  });

  it("shows the four decks changed most lately, each once, and credits the art it shows", () => {
    const decks = [
      deck("old", { updated_at: "2026-01-01T00:00:00Z" }),
      deck("b", { updated_at: "2026-11-02T00:00:00Z", commander_image: "https://cards.scryfall.io/art_crop/b.jpg", commander_artist: "Rebecca Guay", commanders: ["Atraxa, Praetors' Voice"] }),
      deck("c", { updated_at: "2026-11-03T00:00:00Z" }),
      deck("d", { updated_at: "2026-11-04T00:00:00Z" }),
      deck("e", { updated_at: "2026-11-05T00:00:00Z" }),
      deck("config", { updated_at: "2026-11-09T00:00:00Z", parent_id: "e" }),
    ];
    const html = home({ decks });
    const shown = hrefs(html).filter((h) => /^\/decks\/[a-z]+$/.test(h) && h !== "/decks/import");
    expect(shown).toEqual(["/decks/e", "/decks/d", "/decks/c", "/decks/b"]);
    expect(html).toContain("Atraxa, Praetors&#x27; Voice");
    expect(html).toContain("Art by Rebecca Guay. ™ &amp; © Wizards of the Coast.");
    // No art shown, no credit line.
    expect(home({ decks: [deck("a")] })).not.toContain("Wizards of the Coast");
  });

  it("gives an account with no decks or games a next step", () => {
    const html = home();
    expect(html).toContain("No decks yet");
    for (const path of ["/decks/import", "/lab"]) expect(html).toContain(`href="${path}"`);
    expect(html).toContain("No games yet");
  });

  it("lists the latest three games, leaving out one being deleted", () => {
    const html = home({ games: [game("deleted"), game("g1"), game("g2"), game("g3"), game("g4")] });
    const shown = hrefs(html).filter((h) => /^\/table\/games\/./.test(h));
    expect(shown).toEqual(["/table/games/g1", "/table/games/g2", "/table/games/g3"]);
  });

  it("puts a game in progress on top, as the one primary action", () => {
    Object.assign(table, going);
    const html = home();
    expect(html.indexOf("Game in progress")).toBeGreaterThan(0);
    expect(html.indexOf("Game in progress")).toBeLessThan(html.indexOf("Start a game"));
    expect(html).toMatch(/<a class="button primary"[^>]*href="\/table\/play"[^>]*>Back to the table<\/a>/);
    expect(html.match(/class="button primary"/g)).toHaveLength(1);
    // A finished game still in the slot isn't in progress.
    table.state = { ...going.state, finished: true };
    expect(home()).not.toContain("Game in progress");
  });
});

describe("Start here", () => {
  const list = (html: string) => html.match(/<section class="home-start-here".*?<\/section>/s)?.[0] ?? "";

  it("lists the four first steps for a new account, each with where to do it", () => {
    const html = list(home({ copies: 0, groups: 0 }));
    expect(html).toContain("Start here");
    expect(html).toContain("0 of 4 done");
    for (const title of ["Add a deck", "Bring your collection", "Start or join a playgroup", "Play a game"]) expect(html).toContain(`<b>${title}</b>`);
    expect(hrefs(html)).toEqual(["/decks/import", "/lab", "/collection", "/group", "/play/table"]);
    // On top: before starting a game and the empty decks and games sections.
    const page = home({ copies: 0, groups: 0 });
    expect(page.indexOf("home-start-here")).toBeLessThan(page.indexOf("home-start-title"));
  });

  it("marks a step done from the account's own data, and drops its links", () => {
    const html = list(home({ decks: [deck("a")], games: [game("g1")], copies: 0, groups: 0 }));
    expect(html).toContain("2 of 4 done");
    expect(hrefs(html)).toEqual(["/collection", "/group"]);
    expect(html.match(/class="is-done"/g)).toHaveLength(2);
    expect(startSteps({ decks: 1, copies: 0, playgroups: 2, games: 0 }).map((s) => s.done)).toEqual([true, false, true, false]);
  });

  it("goes once every step is done, and never shows signed out", () => {
    expect(list(home({ decks: [deck("a")], games: [game("g1")], copies: 3, groups: 1 }))).toBe("");
    expect(home({ me: null })).not.toContain("Start here");
  });

  it("waits for every answer, so it never flashes for an account that has finished it", () => {
    expect(list(home({ copies: null, groups: 0 }))).toBe("");
    expect(list(home({ copies: 0, groups: null }))).toBe("");
  });
});

describe("opening Yama with a game in progress", () => {
  it("goes straight to the game on the visit's first look at Home, signed in or not", () => {
    Object.assign(table, going, { opening: true });
    expect(home()).toBe("<p>Goes to /table/play</p>");
    expect(home({ me: null })).toBe("<p>Goes to /table/play</p>");
  });

  it("shows Home when coming back to it later, for a game left from another night, and for a finished one", () => {
    Object.assign(table, going, { opening: false });
    expect(home()).toContain("<h1>Home</h1>");
    // Left from another night: a saved game to go back to, not one in progress.
    Object.assign(table, { opening: true, recent: false });
    expect(home()).toContain("Saved game on this device");
    expect(home()).toContain("only if this is the game you’re playing");
    expect(home()).not.toContain("Game in progress");
    Object.assign(table, { recent: true, state: { ...going.state, finished: true } });
    expect(home()).toContain("<h1>Home</h1>");
    Object.assign(table, { game: null, state: null });
    expect(home()).toContain("<h1>Home</h1>");
  });
});
