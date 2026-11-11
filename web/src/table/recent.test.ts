import { describe, expect, it } from "vitest";
import type { GameRow, GameSeat } from "../api";
import { recentGameText, seatLabels, winningSeat } from "./recent";

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
