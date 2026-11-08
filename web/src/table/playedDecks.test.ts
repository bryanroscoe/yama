import { describe, expect, it } from "vitest";
import type { GameRow, GameSeat } from "../api";
import { decksOf, mergeGames, playedDecks, playedLine, possessive, samePerson } from "./playedDecks";

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
    expect(playedDecks(withVersions, "me", [{ name: "Eternal Might", current_version_id: "other" }]).map((d) => `${d.player}:${d.name}`)).toEqual(["Chelsey:Kaalia"]);
    // A guest who borrowed another member's deck (they logged the game) keeps it.
    expect(playedDecks(withVersions, "me", []).map((d) => `${d.player}:${d.name}`)).toEqual(["Chelsey:Kaalia", "Matt:Eternal Might"]);
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

describe("a deck played under a typed name and a member row", () => {
  it("is one row, unless two known people share the name", () => {
    const g = (id: string, day: string, member: string | null) =>
      game(id, day, [{ member_id: member, display_name: "Matt", guest_name: member ? null : "Matt", deck_label: "Jace", commander_name: "Jace" }]);
    expect(playedDecks([g("a", "2026-10-01T00:00:00Z", "m-matt"), g("b", "2026-10-02T00:00:00Z", null)]).map((d) => `${d.player}:${d.games}:${d.last.slice(0, 10)}`)).toEqual(["Matt:2:2026-10-02"]);
    expect(playedDecks([g("a", "2026-10-01T00:00:00Z", "m-matt"), g("c", "2026-10-03T00:00:00Z", "m-other"), g("b", "2026-10-02T00:00:00Z", null)])).toHaveLength(3);
  });
});

describe("an account in two playgroups", () => {
  it("has one row per deck, its games counted together", () => {
    const games = [
      game("x", "2026-10-20T19:00:00Z", [{ member_id: "m-a", user_id: "u-c", display_name: "Chelsey", deck_label: "Kaalia", commander_name: "Kaalia of the Vast" }]),
      game("y", "2026-10-21T19:00:00Z", [{ member_id: "m-b", user_id: "u-c", display_name: "Chelsey", deck_label: "Kaalia", commander_name: "Kaalia of the Vast" }]),
    ];
    expect(playedDecks(games, "me").map((d) => `${d.player}:${d.name}:${d.games}`)).toEqual(["Chelsey:Kaalia:2"]);
  });
});

describe("samePerson", () => {
  it("is one account across playgroups, whatever its member rows", () => {
    expect(samePerson({ name: "Chelsey", memberId: "m-a", userId: "u-c" }, { name: "Chelsey", memberId: "m-b", userId: "u-c" })).toBe(true);
    expect(samePerson({ name: "Alex", memberId: "m-a" }, { name: "Alex", memberId: "m-b" })).toBe(false);
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
