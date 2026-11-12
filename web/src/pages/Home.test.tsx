import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeckSummary, GameRow } from "../api";
import { HOME_LINKS, HomePage } from "./Home";

const table = vi.hoisted(() => ({ game: null as unknown, state: null as unknown, opening: false, recent: true }));
vi.mock("../table/store", () => ({ useTable: () => ({ game: table.game, state: table.state }), usePendingDeletes: () => ["deleted"] }));
vi.mock("../table/resume", () => ({ isOpening: () => table.opening, opened: () => {}, resumesOnOpen: () => table.recent }));
vi.mock("../components/useCardArt", () => ({ useCardArt: () => new Map() }));
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

function home({ me = { id: "u1" } as { id: string } | null, decks = [] as DeckSummary[], games = [] as GameRow[] } = {}) {
  vi.stubGlobal("location", { origin: "https://yama.ing" });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], me);
  client.setQueryData(["decks"], decks);
  client.setQueryData(["games"], games);
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
    expect(HOME_LINKS.map((l) => l.to)).toEqual(["/play/table", "/play", "/precons", "/commanders", "/cards"]);
    // The server's own pages are document links; the app's are routes.
    expect(hrefs(html)).toEqual(["/signin", "/play/table", "/play", "https://yama.ing/precons", "https://yama.ing/commanders", "/cards"]);
  });

  it("shows nothing of an account's: no decks, games or game in progress", () => {
    Object.assign(table, going);
    const html = home({ me: null, decks: [deck("a")], games: [game("g1")] });
    for (const text of ["Deck a", "Kelly", "Your recent decks", "Game in progress", "latest games"]) expect(html).not.toContain(text);
  });
});

describe("Home, signed in", () => {
  it("offers starting a game, your recent decks and your playgroup's latest games", () => {
    const html = home({ decks: [deck("a")], games: [game("g1")] });
    expect(html).toContain("<h1>Home</h1>");
    for (const title of ["Start a game", "Your recent decks", "Your playgroup&#x27;s latest games"]) expect(html).toContain(title);
    expect(html).toMatch(/<a class="button primary"[^>]*href="\/play\/table"[^>]*>Count life at the table<\/a>/);
    for (const path of ["/play", "/decks/a", "/decks", "/table/games/g1", "/table/games", "/group"]) expect(html).toContain(`href="${path}"`);
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

describe("opening Yama with a game in progress", () => {
  it("goes straight to the game on the visit's first look at Home, signed in or not", () => {
    Object.assign(table, going, { opening: true });
    expect(home()).toBe("<p>Goes to /table/play</p>");
    expect(home({ me: null })).toBe("<p>Goes to /table/play</p>");
  });

  it("shows Home when coming back to it later, for a game left from another night, and for a finished one", () => {
    Object.assign(table, going, { opening: false });
    expect(home()).toContain("<h1>Home</h1>");
    Object.assign(table, { opening: true, recent: false });
    expect(home()).toContain("Game in progress");
    Object.assign(table, { recent: true, state: { ...going.state, finished: true } });
    expect(home()).toContain("<h1>Home</h1>");
    Object.assign(table, { game: null, state: null });
    expect(home()).toContain("<h1>Home</h1>");
  });
});
