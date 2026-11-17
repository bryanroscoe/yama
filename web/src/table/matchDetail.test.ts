import { describe, expect, it } from "vitest";
import type { GameDetail, GameSeat } from "../api";
import { matchFromServer, matchSummary } from "./GameDetail";

const seat = (n: number, name: string): GameSeat => ({
  seat: n,
  member_id: null,
  user_id: null,
  guest_name: name,
  deck_label: null,
  commander_name: null,
  final_life: null,
  eliminated_turn: null,
  eliminated_by_seat: null,
  fun: null,
  display_name: name,
});

describe("a game's match on its page", () => {
  const games = [
    { id: "a", game: 1, status: "finished", winner: "Sam" },
    { id: "b", game: 2, status: "finished", winner: "Alex" },
    { id: "c", game: 3, status: "in_progress", winner: null },
  ];

  it("tells where the match stands from its games' winners", () => {
    expect(matchSummary(3, games.slice(0, 1), ["Sam", "Alex"])).toBe("Best of 3, Sam leads 1–0.");
    expect(matchSummary(3, games, ["Sam", "Alex"])).toBe("Best of 3, level at 1–1.");
    expect(matchSummary(3, [...games.slice(0, 2), { id: "c", game: 3, status: "finished", winner: "Alex" }], ["Sam", "Alex"])).toBe("Alex won the match 2–1.");
    expect(matchSummary(3, [], ["Sam", "Alex"])).toBe("Best of 3, no games finished yet.");
  });

  it("rebuilds the score so far for a game carried on from Yama, by the winners' names", () => {
    const g = { match_id: "m", match_game: 3, match_best_of: 3, match_games: games, seats: [seat(0, "Alex"), seat(1, "Sam")] } as Pick<GameDetail, "match_id" | "match_game" | "match_best_of" | "match_games" | "seats">;
    expect(matchFromServer(g)).toEqual({ id: "m", bestOf: 3, game: 3, wins: [1, 1], draws: 0 });
    expect(matchFromServer({ ...g, match_id: null })).toBeNull();
  });
});
