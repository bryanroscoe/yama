import { describe, expect, it } from "vitest";
import type { GameDetail, GameSeat } from "../api";
import { matchFromServer, matchSummary, setupFromServer } from "./GameDetail";

const seat = (n: number, name: string, more: Partial<GameSeat> = {}): GameSeat => ({
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
  ...more,
});

const game2 = {
  match_id: "m",
  match_game: 2,
  match_best_of: 3,
  match_wins: [0, 1],
  match_draws: 0,
  status: "finished",
  winner_seat: 1,
  // Alex was "Player 2" when they won game 1: the score is kept by seat, so the rename loses nothing.
  seats: [seat(0, "Sam"), seat(1, "Alex")],
};

describe("a game's match on its page", () => {
  it("rebuilds the score before the game from what the server kept, by seat", () => {
    expect(matchFromServer(game2)).toEqual({ id: "m", bestOf: 3, game: 2, wins: [0, 1], draws: 0 });
    expect(matchFromServer({ ...game2, match_id: null })).toBeNull();
    // A game saved before the score was kept counts from nothing.
    expect(matchFromServer({ ...game2, match_wins: null, match_draws: null })).toMatchObject({ wins: [0, 0], draws: 0 });
  });

  it("tells where the match stood after the game, naming this game's players", () => {
    const m = matchFromServer(game2)!;
    expect(matchSummary(m, game2)).toBe("Alex won the match 2–0.");
    expect(matchSummary(m, { ...game2, winner_seat: 0 })).toBe("Best of 3. After this game, level at 1–1.");
    expect(matchSummary(m, { ...game2, status: "in_progress", winner_seat: null })).toBe("Best of 3. Before this game, Alex leads 1–0.");
    expect(matchSummary(m, { ...game2, winner_seat: null })).toBe("Best of 3. After this game, Alex leads 1–0.");
  });

  it("keeps a seat's deck colors outside Commander", () => {
    const g = { ...game2, id: "g", mode: "in_person", playgroup_id: null, format: "limited", starting_life: 20, started_at: "2026-11-17T19:00:00Z", ended_at: null, turns: null, first_seat: null, win_condition: null, events: [], can_continue: true, seats: [seat(0, "Sam", { colors: "WU" }), seat(1, "Alex")] } as GameDetail;
    expect(setupFromServer(g).setup.players.map((p) => p.colorIdentity)).toEqual(["WU", ""]);
    expect(setupFromServer(g).setup.match).toMatchObject({ game: 2, wins: [0, 1] });
  });
});
