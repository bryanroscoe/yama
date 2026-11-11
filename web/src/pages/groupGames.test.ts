import { describe, expect, it } from "vitest";
import type { GameRow, GameSeat, Member, PlayerStat } from "../api";
import { playerKeys, readGames } from "./groupGames";

const members: Member[] = [
  { id: "m-me", user_id: "u-me", guest_name: null, display_name: "Bryan", handle: null },
  { id: "m-sam", user_id: "u-sam", guest_name: null, display_name: "Sam", handle: null },
  { id: "m-guest", user_id: null, guest_name: "Kelly", display_name: "Kelly", handle: null },
];

const seat = (n: number, who: Partial<GameSeat>): GameSeat => ({
  seat: n,
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
  ...who,
});

const game = (id: string, mode: string, winner: number, seats: GameSeat[]): GameRow => ({
  id,
  mode,
  playgroup_id: "pg",
  status: "finished",
  started_at: "2026-11-01T00:00:00Z",
  ended_at: null,
  turns: null,
  winner_seat: winner,
  first_seat: null,
  win_condition: null,
  seats,
});

describe("playgroup rivalries", () => {
  const keys = playerKeys(members);

  it("counts online games, whose seats used to carry the account without the member", () => {
    const games = [
      // At the table: both seats name their member rows.
      game("table", "in_person", 0, [seat(0, { member_id: "m-me", user_id: "u-me", display_name: "Bryan" }), seat(1, { member_id: "m-sam", user_id: "u-sam", display_name: "Sam" })]),
      // Online before members were recorded: accounts only.
      game("old-online", "online", 1, [seat(0, { user_id: "u-me", display_name: "Bryan" }), seat(1, { user_id: "u-sam", display_name: "Sam" })]),
      // Online now: the member rows are there.
      game("online", "online", 1, [seat(0, { member_id: "m-me", user_id: "u-me", display_name: "Bryan" }), seat(1, { member_id: "m-sam", user_id: "u-sam", display_name: "Sam" })]),
    ];
    const read = readGames(games, keys.account("u-me"), keys.seat);
    expect(read.beatsMe).toMatchObject({ key: "m-sam", name: "Sam", shared: 3, mine: 1, theirs: 2 });
    expect(read.iBeat).toBeUndefined();
  });

  it("leaves the computer and solo games against it out, as the server's stats do", () => {
    const meSeat = seat(0, { member_id: "m-me", user_id: "u-me", display_name: "Bryan", commander_name: "Éowyn, Shieldmaiden" });
    const sam = seat(1, { member_id: "m-sam", user_id: "u-sam", display_name: "Sam", commander_name: "Frodo, Adventurous Hobbit" });
    const computer = (n: number) => seat(n, { guest_name: "Atraxa, Praetors' Voice", display_name: "Atraxa, Praetors' Voice", ai_kind: "phase-ai Hard", commander_name: "Atraxa, Praetors' Voice" });
    const games = [
      // Solo against two computers, won and lost: nobody to compare with.
      game("solo-won", "online", 0, [meSeat, computer(1), computer(2)]),
      game("solo-lost", "online", 2, [meSeat, computer(1), computer(2)]),
      // Two people and a computer, which wins: a loss for both, a win for neither.
      game("mixed", "online", 2, [meSeat, sam, computer(2)]),
      game("table", "in_person", 0, [meSeat, sam]),
    ];
    const read = readGames(games, keys.account("u-me"), keys.seat);
    expect(read.iBeat).toMatchObject({ key: "m-sam", shared: 2, mine: 1, theirs: 0 });
    expect(read.beatsMe).toBeUndefined();
    // The computer's commander isn't one the playgroup played, and solo games don't pick a favourite.
    expect(read.players("Atraxa, Praetors' Voice")).toEqual([]);
    expect(read.players("Éowyn, Shieldmaiden")).toEqual(["Bryan"]);
    expect(read.favourite("m-me")).toBe("Éowyn, Shieldmaiden");
    expect(readGames(games.slice(0, 2), keys.account("u-me"), keys.seat).favourite("m-me")).toBeNull();
  });

  it("reads commanders from Commander games only", () => {
    const constructed = { ...game("std", "in_person", 0, [seat(0, { member_id: "m-me", commander_name: "A deck name" }), seat(1, { member_id: "m-sam" })]), format: "standard" };
    const read = readGames([constructed], "m-me", keys.seat);
    expect(read.players("A deck name")).toEqual([]);
    expect(read.favourite("m-me")).toBeNull();
    // It's still a game the two of them played.
    expect(read.iBeat).toMatchObject({ key: "m-sam", shared: 1, mine: 1 });
  });

  it("keys a seat the way the server keys its player", () => {
    expect(keys.seat(seat(0, { member_id: "m-guest", guest_name: "Kelly" }))).toBe("m-guest");
    expect(keys.seat(seat(0, { user_id: "u-sam" }))).toBe("m-sam");
    // Someone with an account who isn't in the group, and a typed name.
    expect(keys.seat(seat(0, { user_id: "u-visitor" }))).toBe("u:u-visitor");
    expect(keys.seat(seat(0, { guest_name: "Alex" }))).toBe("g:Alex");
    const stat = (key: string, member_id: string | null) => ({ key, member_id }) as PlayerStat;
    expect(keys.player(stat("u:u-sam", null))).toBe("m-sam");
    expect(keys.player(stat("u:u-visitor", null))).toBe("u:u-visitor");
    expect(keys.player(stat("g:Alex", null))).toBe("g:Alex");
    expect(keys.player(stat("u:u-me", "m-me"))).toBe("m-me");
    expect(keys.account("u-visitor")).toBe("u:u-visitor");
    expect(keys.account(undefined)).toBeUndefined();
  });
});
