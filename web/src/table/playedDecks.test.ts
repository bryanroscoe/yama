import { describe, expect, it } from "vitest";
import type { GameRow, GameSeat } from "../api";
import { decksOf, mergeGames, playedDecks, playedLine, possessive } from "./playedDecks";

const seat = (s: Partial<GameSeat>): GameSeat => ({
  seat: 0,
  member_id: null,
  user_id: null,
  guest_name: null,
  deck_label: null,
  commander_name: null,
  final_life: null,
  eliminated_turn: null,
  eliminated_by_seat: null,
  fun: null,
  display_name: null,
  ...s,
});
const game = (id: string, started_at: string, seats: Partial<GameSeat>[]): GameRow =>
  ({ id, mode: "in_person", playgroup_id: "g", status: "finished", started_at, ended_at: null, turns: null, winner_seat: null, first_seat: null, win_condition: null, seats: seats.map(seat) }) as GameRow;

describe("playedDecks", () => {
  const games = [
    game("a", "2026-10-20T19:00:00Z", [
      { member_id: "m-matt", display_name: "Matt", deck_label: "Food and Fellowship", commander_name: "Frodo, Adventurous Hobbit" },
      { member_id: "m-chris", display_name: "Chris", deck_label: "Tana and Tymna", commander_name: "Tana" },
      { user_id: "me", display_name: "Bryan", deck_version_id: "v1", deck_label: null, commander_name: "Varina, Lich Queen" },
      { display_name: "Player 4", deck_label: "Atraxa", commander_name: "Atraxa" },
      { display_name: "AI", ai_kind: "phase-ai", commander_name: "Atraxa" },
    ]),
    game("b", "2026-10-25T19:00:00Z", [
      { member_id: "m-matt", display_name: "Matt", deck_label: "Food and Fellowship", commander_name: "Frodo, Adventurous Hobbit" },
      { guest_name: "matt", display_name: "matt", deck_label: "Jace", commander_name: "Jace" },
    ]),
  ];

  it("keeps each person's decks once, with how often and when they were last played", () => {
    const played = playedDecks(games, "me");
    // Your own Yama decks, AI seats and temporary labels aren't listed.
    expect(played.map((d) => `${d.player}:${d.name}:${d.games}`)).toEqual(["Matt:Food and Fellowship:2", "matt:Jace:1", "Chris:Tana and Tymna:1"]);
    const pair = played.find((d) => d.player === "Chris")!;
    // A seat named only by its commanders isn't a deck name.
    expect(pair).toMatchObject({ named: false, commanders: ["Tana", "Tymna"] });
    expect(played[0]).toMatchObject({ named: true, last: "2026-10-25T19:00:00Z" });
  });

  it("keeps a deck another account played from its own list, and drops yours", () => {
    const withVersions = [
      game("c", "2026-10-27T19:00:00Z", [
        { member_id: "m-chelsey", user_id: "u-chelsey", display_name: "Chelsey", deck_version_id: "her-v", deck_label: "Kaalia", commander_name: "Kaalia of the Vast" },
        { member_id: "m-me", user_id: "me", display_name: "Bryan", deck_version_id: "my-v", commander_name: "Varina, Lich Queen" },
        { member_id: "m-matt", display_name: "Matt", deck_version_id: "lent-v", deck_label: "Eternal Might", commander_name: "Varina, Lich Queen" },
      ]),
    ];
    expect(playedDecks(withVersions, "me").map((d) => `${d.player}:${d.name}`)).toEqual(["Chelsey:Kaalia"]);
  });

  it("finds one person's decks under their member row and their typed name", () => {
    const mine = decksOf(playedDecks(games, "me"), { name: "Matt", memberId: "m-matt" });
    expect(mine.map((d) => d.name)).toEqual(["Food and Fellowship", "Jace"]);
    expect(decksOf(playedDecks(games, "me"), { name: "" })).toEqual([]);
  });

  it("says whose and how often", () => {
    const [d] = playedDecks(games, "me");
    expect(playedLine(d!)).toBe("Matt, 2 games, last Oct 25");
    expect(playedLine({ ...d!, games: 1 }, false)).toBe("Played Oct 25");
    expect(possessive("Chelsey Roscoe")).toBe("Chelsey's");
  });
});

describe("mergeGames", () => {
  it("counts a game in both your list and the playgroup's once", () => {
    const g = game("a", "2026-10-20T19:00:00Z", [{ member_id: "m-matt", display_name: "Matt", deck_label: "Jace", commander_name: "Jace" }]);
    const other = game("b", "2026-10-21T19:00:00Z", [{ member_id: "m-matt", display_name: "Matt", deck_label: "Jace", commander_name: "Jace" }]);
    expect(mergeGames([g], [g, other], undefined).map((x) => x.id)).toEqual(["a", "b"]);
    expect(playedDecks(mergeGames([g], [g, other]))[0]!.games).toBe(2);
  });
});
