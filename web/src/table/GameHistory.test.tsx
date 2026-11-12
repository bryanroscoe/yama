import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { GameRow } from "../api";
import { emptyHistory, GameHistoryPage } from "./GameHistory";

vi.mock("../auth", () => ({ useMe: () => ({ data: { id: "me" } }) }));
vi.mock("./store", () => ({ usePendingDeletes: () => ["deleted"] }));

function page(query: string, games: GameRow[], hasMore = false) {
  const p = new URLSearchParams(query);
  const client = new QueryClient();
  client.setQueryData(["games", "history", "me", p.get("filter") ?? "all", p.get("order") ?? "newest", p.get("q") ?? "", Number(p.get("offset") ?? 0)], { games, has_more: hasMore });
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/table/games?${query}`]}><GameHistoryPage /></MemoryRouter></QueryClientProvider>);
}

const game = (id: string, more: Partial<GameRow> = {}) => ({
  id, mode: "in_person", status: "finished", started_at: "2026-10-31T01:00:00Z", winner_seat: 0,
  seats: [{ seat: 0, display_name: "Kelly", commander_name: "Atraxa" }, { seat: 1, display_name: "Dude 2" }], ...more,
}) as GameRow;

describe("game history", () => {
  it("shows corrected players, missing-name hints and detail links, hiding pending deletes", () => {
    const html = page("", [game("kept"), game("deleted")]);
    expect(html).toContain("Kelly won with Atraxa");
    expect(html).toContain("Kelly (Atraxa), Dude 2");
    expect(html).toContain("1 unnamed player");
    expect(html).toContain('href="/table/games/kept"');
    expect(html).not.toContain('/table/games/deleted');
    // One page of games has nothing to page through.
    expect(html).not.toContain("Previous");
    expect(html).not.toContain("Page 1");
  });

  it("gives an account with no games a next step, and no filters' worth of dead ends", () => {
    const html = page("", []);
    expect(html).toContain("No games yet");
    expect(html).toMatch(/<a [^>]*href="\/play\/table"[^>]*>Start a game<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/play\/table"[^>]*>Log one you played<\/a>/);
    expect(html).not.toContain("No matching games");
    expect(html).not.toContain("Previous");
    expect(emptyHistory({ filter: "all", search: "  ", offset: 0 })).toBe("none");
  });

  it("says a search or a filter found nothing, with the way back to every game", () => {
    const searched = page("q=Zed", []);
    expect(searched).toContain("No games match “Zed”.");
    expect(searched).toMatch(/<a [^>]*href="\/table\/games"[^>]*>Show all games<\/a>/);
    expect(searched).not.toContain("No games yet");
    expect(page("filter=unfinished", [])).toContain("No games match among unfinished games.");
    expect(page("filter=unnamed&q=Kelly", [])).toContain("No games match “Kelly” among games with unnamed players.");
    // A page past the last game says so and leads back.
    const past = page("offset=50", []);
    expect(past).toContain("No more games on this page.");
    expect(past).toMatch(/<button[^>]*>Back to the first page<\/button>/);
    expect(past).toContain('<button type="button" aria-disabled="false">Previous</button>');
    // Every game on the page is waiting to be deleted: the page is empty, not the account's history wrong.
    expect(page("", [game("deleted")])).toContain("No games yet");
  });

  it("opens an old unfinished page with its search, order and next page available", () => {
    const html = page("filter=unfinished&order=oldest&q=Kelly&offset=50", [game("old", { status: "in_progress" })], true);
    expect(html).toContain('aria-pressed="true">Unfinished</button>');
    expect(html).toContain('value="Kelly"');
    expect(html).toContain('value="oldest" selected=""');
    expect(html).toContain("Page 2");
    expect(html).toContain('<button type="button" aria-disabled="false">Previous</button>');
    expect(html).toContain('<button type="button" aria-disabled="false">Next</button>');
    expect(html).toContain("Still going, 1 unnamed player");
  });

  it("keeps online replay links and doesn't flag computer seats as unnamed people", () => {
    const html = page("filter=unnamed", [game("online", { mode: "online", seats: [{ seat: 0, display_name: "Player 2", ai_kind: "phase-ai" }] } as Partial<GameRow>)]);
    expect(html).toContain('href="/play/online"');
    expect(html).not.toContain("1 unnamed player");
  });
});
