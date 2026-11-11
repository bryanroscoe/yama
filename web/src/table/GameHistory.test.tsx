import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { GameRow } from "../api";
import { GameHistoryPage } from "./GameHistory";

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
    expect(html).toContain('<button disabled="">Previous</button>');
    expect(html).toContain('<button disabled="">Next</button>');
  });

  it("opens an old unfinished page with its search, order and next page available", () => {
    const html = page("filter=unfinished&order=oldest&q=Kelly&offset=50", [game("old", { status: "in_progress" })], true);
    expect(html).toContain('aria-pressed="true">Unfinished</button>');
    expect(html).toContain('value="Kelly"');
    expect(html).toContain('value="oldest" selected=""');
    expect(html).toContain("Page 2");
    expect(html).toContain("<button>Previous</button>");
    expect(html).toContain("<button>Next</button>");
    expect(html).toContain("Still going, 1 unnamed player");
  });

  it("keeps online replay links and doesn't flag computer seats as unnamed people", () => {
    const html = page("filter=unnamed", [game("online", { mode: "online", seats: [{ seat: 0, display_name: "Player 2", ai_kind: "phase-ai" }] } as Partial<GameRow>)]);
    expect(html).toContain('href="/play/online"');
    expect(html).not.toContain("1 unnamed player");
  });
});
