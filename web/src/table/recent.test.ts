import { describe, expect, it } from "vitest";
import type { GameRow, GameSeat } from "../api";
import type { LoggedEvent, TableSetup } from "@yama/core";
import { localGameRow, recentGameText, seatLabels, seatResultText, winningSeat } from "./recent";

const seat = (n: number, name: string | null, commander: string | null, more: Partial<GameSeat> = {}): GameSeat => ({
  seat: n,
  member_id: null,
  user_id: null,
  guest_name: null,
  deck_label: null,
  commander_name: commander,
  final_life: null,
  eliminated_turn: null,
  eliminated_by_seat: null,
  fun: null,
  display_name: name,
  ...more,
});

const game = (seats: GameSeat[], more: Partial<GameRow> = {}): GameRow => ({
  id: "g",
  mode: "in_person",
  playgroup_id: null,
  status: "finished",
  started_at: "2026-10-16T19:00:00Z",
  ended_at: null,
  turns: 11,
  winner_seat: null,
  first_seat: null,
  win_condition: null,
  seats,
  ...more,
});

describe("recent game text", () => {
  it("names the winner with their own commander for that game, found by seat number", () => {
    // Seats arrive out of order; the winner is seat 1, Sam, on Éowyn this game.
    const g = game([seat(2, "Priya", "Terra, Herald of Hope"), seat(0, "Bryan", "Omo, Queen of Vesuva"), seat(1, "Sam", "Éowyn, Shieldmaiden")], { winner_seat: 1 });
    expect(winningSeat(g)?.display_name).toBe("Sam");
    const t = recentGameText(g);
    expect(t.title).toBe("Sam won");
    expect(t.with).toBe("Éowyn");
    expect(t.sub).toBe("Over Terra and Omo");
    expect(t.short).toBe("Éowyn, 11 turns");
  });

  it("leaves the winner out of the Over list and tells apart seats on the same commander", () => {
    // An online game: Bryan on Mister Fantastic, and three computer seats named after their commanders.
    const ai = { ai_kind: "phase-ai easy" };
    const g = game(
      [
        seat(0, "Bryan", "Mister Fantastic", { user_id: "u1" }),
        seat(1, "Éowyn, Shieldmaiden", "Éowyn, Shieldmaiden", ai),
        seat(2, "Mister Fantastic", "Mister Fantastic", ai),
        seat(3, "Éowyn, Shieldmaiden", "Éowyn, Shieldmaiden", ai),
      ],
      { winner_seat: 2, mode: "online", turns: 34 },
    );
    const t = recentGameText(g);
    expect(t.title).toBe("Mister Fantastic won");
    expect(t.with).toBeNull();
    expect(t.sub).toBe("Over Mister Fantastic (Bryan), Éowyn (seat 2) and Éowyn (seat 4)");
    // The rules engine counts every player's turn, which isn't the table's rounds.
    expect(t.short).toBe("Mister Fantastic, 34 player turns");
  });

  it("uses player names when two people play the same commander", () => {
    const labels = seatLabels([seat(0, "Sam", "Éowyn, Shieldmaiden"), seat(1, "Priya", "Éowyn, Shieldmaiden"), seat(2, "Jules", "Mister Fantastic")]);
    expect(labels).toEqual(["Éowyn (Sam)", "Éowyn (Priya)", "Mister Fantastic"]);
  });

  it("lists every seat once for a draw or a game still going", () => {
    const seats = [seat(0, "Bryan", "Éowyn, Shieldmaiden"), seat(1, "Sam", "Quintorius, History Chaser"), seat(2, "Player 3", null), seat(3, "Priya", "Terra, Herald of Hope")];
    expect(recentGameText(game(seats, { status: "in_progress", turns: null }))).toEqual({
      title: "Still going",
      with: null,
      sub: "Éowyn, Quintorius, Player 3 and Terra",
      short: "Éowyn, Quintorius, Player 3 and Terra",
    });
    const draw = recentGameText(game(seats, { turns: 14 }));
    expect(draw.title).toBe("A draw");
    expect(draw.sub).toBe("Éowyn, Quintorius, Player 3 and Terra");
    expect(draw.short).toBe("14 turns");
  });

  it("adds how it was won and the note", () => {
    const g = game([seat(0, "Bryan", "Éowyn, Shieldmaiden"), seat(1, "Sam", "Quintorius, History Chaser")], { winner_seat: 0, win_condition: "combat" });
    const t = recentGameText({ ...g, note: "Sam's new deck" });
    expect(t.with).toBe("Éowyn");
    expect(t.sub).toBe("Combat. Over Quintorius. Sam's new deck");
    // The fixed note logged games used to get isn't something anyone wrote.
    expect(recentGameText({ ...g, note: "Logged after the game" }).sub).toBe("Combat. Over Quintorius");
  });
});

describe("recent game text for other game types", () => {
  it("says a game's type when it isn't Commander, and which game of a match it was", () => {
    const g = game([seat(0, "Sam", null), seat(1, "Alex", null)], { winner_seat: 0, format: "limited", match_id: "m", match_game: 2, match_best_of: 3 });
    expect(recentGameText(g).sub).toBe("Limited, game 2 of 3. Over Alex");
    expect(recentGameText({ ...g, format: "commander" }).sub).toBe("Game 2 of 3. Over Alex");
    expect(recentGameText({ ...g, match_id: null, match_game: null, match_best_of: null }).sub).toBe("Limited. Over Alex");
  });
});

describe("a seat's result on the game's page", () => {
  const name = (n: number) => ["Bryan", "Chris", "Matt"][n];
  const at = (more: Partial<GameSeat>) => seat(1, "Chris", null, more);

  it("says who knocked a player out when the table never counted turns", () => {
    // Saved without a turn: the seat still names who did it, and still shows its life.
    expect(seatResultText(at({ final_life: 40, eliminated_by_seat: 0 }), { won: false, going: false, name })).toBe("Knocked out by Bryan");
  });

  it("names the turn only when there is one", () => {
    expect(seatResultText(at({ eliminated_turn: 7, eliminated_by_seat: 2 }), { won: false, going: false, name })).toBe("Out on turn 7, by Matt");
    expect(seatResultText(at({ eliminated_turn: 7 }), { won: false, going: false, name })).toBe("Out on turn 7");
  });

  it("reads a knockout with nobody named from the table's own record", () => {
    expect(seatResultText(at({ final_life: 3 }), { won: false, going: false, knocked: {}, name })).toBe("Knocked out");
    expect(seatResultText(at({}), { won: false, going: true, knocked: { bySeat: 0 }, name })).toBe("Knocked out by Bryan");
    // Out by their own hand isn't "by" anyone.
    expect(seatResultText(at({ eliminated_by_seat: 1 }), { won: false, going: false, name })).toBe("Knocked out");
  });

  it("keeps the winner, the survivors and a game still going as they were", () => {
    expect(seatResultText(at({ final_life: 12, eliminated_by_seat: 0 }), { won: true, going: false, name })).toBe("Won");
    expect(seatResultText(at({ final_life: 12 }), { won: false, going: false, name })).toBe("12 life at the end");
    expect(seatResultText(at({}), { won: false, going: true, name })).toBe("Still in");
    expect(seatResultText(at({}), { won: false, going: false, name })).toBe("");
  });
});

describe("a game kept on this device, as a row of recent games", () => {
  const setup: TableSetup = {
    id: "local-1",
    startedAt: "2026-11-21T19:00:00.000Z",
    format: "commander",
    startingLife: 40,
    players: [
      { seat: 0, name: "Me", colorIdentity: "" },
      { seat: 1, name: "Player 2", colorIdentity: "", commanderName: "Atraxa, Praetors' Voice" },
      { seat: 2, name: "Player 3", colorIdentity: "" },
    ],
  };
  const at = "2026-11-21T19:30:00.000Z";
  const log: LoggedEvent[] = [
    { seq: 1, at, event: { type: "player", seat: 1, name: "Matt S", was: { name: "Player 2" } } },
    { seq: 2, at, event: { type: "eliminate", seat: 2, bySeat: 1 } },
    { seq: 3, at, event: { type: "finish", winnerSeat: 1, endedAt: at, winCondition: "combat" } },
  ];

  it("names the winner and the players as the table left them", () => {
    const row = localGameRow(setup, log);
    expect(row).toMatchObject({ id: "local-1", status: "finished", winner_seat: 1, win_condition: "combat", started_at: setup.startedAt });
    expect(row.seats.map((s) => s.display_name)).toEqual(["Me", "Matt S", "Player 3"]);
    expect(row.seats[2]).toMatchObject({ eliminated_by_seat: 1 });
    const text = recentGameText(row);
    expect(text.title).toBe("Matt S won");
    expect(text.with).toBe("Atraxa");
    expect(text.sub).toBe("Combat. Over Me and Player 3");
  });

  it("reads a game with no finish as still going", () => {
    const row = localGameRow(setup, log.slice(0, 2));
    expect(row).toMatchObject({ status: "in_progress", winner_seat: null, ended_at: null });
    expect(recentGameText(row).title).toBe("Still going");
  });
});
