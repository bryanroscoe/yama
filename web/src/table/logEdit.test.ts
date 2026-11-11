import { describe, expect, it } from "vitest";
import type { DeckSummary, GameDetail, GameSeat } from "../api";
import { formFromGame, isLoggedGame, seatResults, settleRebuilt, splitPair } from "./logEdit";

const seat = (n: number, p: Partial<GameSeat>): GameSeat => ({
  seat: n, member_id: null, user_id: null, guest_name: null, deck_version_id: null, deck_label: null, commander_name: null,
  final_life: null, eliminated_turn: null, eliminated_by_seat: null, fun: null, display_name: null, ...p,
});

const game = (p: Partial<GameDetail>): GameDetail => ({
  id: "g", mode: "in_person", playgroup_id: null, status: "finished", started_at: "2026-10-20T20:00:00", ended_at: null, turns: 9,
  winner_seat: 2, first_seat: 1, win_condition: "combat", events: [], can_continue: false, can_edit: true, seats: [], ...p,
});

const myDeck = { id: "d1", name: "Riders of Rohan", color_identity: "RW", commander_image: "https://cards.scryfall.io/art.jpg", commander_artist: "Someone" } as unknown as DeckSummary;

describe("a logged game's knockouts and note", () => {
  it("come back into the form on the seats they were about", () => {
    const f = formFromGame(
      game({
        note: "Sam's new deck",
        seats: [
          seat(2, { guest_name: "Alex", eliminated_turn: 7, eliminated_by_seat: 0 }),
          seat(0, { guest_name: "Bryan" }),
          // Out, and nobody remembers the turn.
          seat(1, { guest_name: "Sam", eliminated_by_seat: 2 }),
        ],
      }),
    );
    expect(f.outs).toEqual([{ seat: 1, turn: null, by: 2 }, { seat: 2, turn: 7, by: 0 }]);
    expect(f.note).toBe("Sam's new deck");
    // The note every logged game used to get isn't one anybody wrote.
    expect(formFromGame(game({ note: "Logged after the game" })).note).toBe("");
    expect(formFromGame(game({ note: null })).outs).toEqual([]);
  });

  it("are saved against the seats that are kept, renumbered", () => {
    // Four places in the form; place 1 was left blank, so places 0, 2, 3 become seats 0, 1, 2.
    const kept = [0, 2, 3];
    const fun = [{ seat: 0, rating: 4 }, { seat: 1, rating: 2 }];
    const outs = [{ seat: 2, turn: 6, by: 3 }, { seat: 3, turn: null, by: 1 }, { seat: 0, turn: 9, by: 2 }];
    // Place 0 won: the knockout ticked for them before isn't saved.
    expect(seatResults(kept, 0, fun, outs)).toEqual([
      { seat: 0, fun: 4, eliminated_turn: null, eliminated_by_seat: null },
      { seat: 1, fun: null, eliminated_turn: 6, eliminated_by_seat: 2 },
      // Knocked out by the player whose place was dropped: the knockout stays, the name goes.
      { seat: 2, fun: null, eliminated_turn: null, eliminated_by_seat: null },
    ]);
    // A draw has no winner to leave out, and a seat with nothing to say isn't sent.
    expect(seatResults([0, 1], null, [], [{ seat: 1, turn: 3, by: 0 }])).toEqual([{ seat: 1, fun: null, eliminated_turn: 3, eliminated_by_seat: 0 }]);
  });
});

describe("isLoggedGame", () => {
  const event = { seq: 1, actor_seat: 0, kind: "life", payload: { type: "life", seat: 0, delta: -1 }, created_at: null };

  it("goes by what was recorded, not by whether the game has a note", () => {
    // Log a game's own: finished, nothing from the table, whatever its note says.
    expect(isLoggedGame(game({ note: "Logged after the game" }))).toBe(true);
    expect(isLoggedGame(game({ note: null }))).toBe(true);
    // A table game with a note was still played at the table.
    expect(isLoggedGame(game({ note: "Sam left early", events: [event] }))).toBe(false);
    // A table that hasn't recorded anything yet, and an online game.
    expect(isLoggedGame(game({ status: "in_progress", note: "Second game of the night" }))).toBe(false);
    expect(isLoggedGame(game({ mode: "online", note: "Rematch" }))).toBe(false);
  });
});

describe("formFromGame", () => {
  it("puts every answer back on the seat it was about", () => {
    const f = formFromGame(
      game({
        your_decks: { 0: "d1", 3: "d1" },
        // Out of order on purpose: the form follows seat numbers.
        seats: [
          seat(2, { guest_name: "@sam", deck_label: "Food and Fellowship", commander_name: "Frodo, Adventurous Hobbit", fun: 4 }),
          seat(0, { user_id: "u-me", display_name: "Bryan", deck_version_id: "v1", deck_label: "Éomer, King of Rohan", commander_name: "Éomer, King of Rohan" }),
          seat(1, { guest_name: "Alex", deck_label: "Tymna the Weaver and Kraum, Ludevic's Opus", commander_name: "Tymna the Weaver" }),
          // Your deck, lent to a guest.
          seat(3, { guest_name: "Jo", deck_version_id: "v1", deck_label: "Riders of Rohan", commander_name: "Éomer, King of Rohan" }),
        ],
      }),
      [myDeck],
    );
    expect(f).toMatchObject({ date: "2026-10-20", turns: "9", winner: 2, first: 1, condition: "combat", fun: [{ seat: 2, rating: 4 }] });
    expect(f.seats[0]).toMatchObject({ name: "Bryan", userId: "u-me", deckId: "d1", deckVersionId: "v1", deckLabel: undefined, art: myDeck.commander_image });
    expect(f.seats[1]).toMatchObject({ name: "Alex", commanderName: "Tymna the Weaver", partnerName: "Kraum, Ludevic's Opus", deckLabel: undefined });
    expect(f.seats[2]).toMatchObject({ name: "@sam", handle: "sam", deckLabel: "Food and Fellowship", commanderName: "Frodo, Adventurous Hobbit" });
    expect(f.seats[3]).toMatchObject({ name: "Jo", deckId: "d1", deckLabel: "Riders of Rohan" });
  });

  it("reads a lent deck named after its commander as a name, not a pair", () => {
    const tymna = { ...myDeck, name: "Tymna the Weaver and Friends", commanders: ["Tymna the Weaver"] } as DeckSummary;
    const f = formFromGame(
      game({ your_decks: { 0: "d1" }, seats: [seat(0, { guest_name: "Jo", deck_version_id: "v1", deck_label: "Tymna the Weaver and Friends", commander_name: "Tymna the Weaver" })] }),
      [tymna],
    );
    expect(f.seats[0]).toMatchObject({ commanderName: "Tymna the Weaver", partnerName: undefined, deckLabel: "Tymna the Weaver and Friends" });
  });

  it("keeps a game's format and starting life", () => {
    expect(formFromGame(game({ format: "standard", starting_life: 20 }))).toMatchObject({ format: "standard", startingLife: 20 });
    expect(formFromGame(game({}))).toMatchObject({ format: "commander", startingLife: 40 });
  });

  it("reads a finished game without a winner as a draw", () => {
    expect(formFromGame(game({ winner_seat: null, first_seat: null, seats: [seat(0, { guest_name: "Jo" })] }))).toMatchObject({ winner: "draw", first: null });
  });
});

describe("splitPair", () => {
  it("finds the partner in the label", () => {
    expect(splitPair({ commander_name: "Tymna the Weaver", deck_label: "Tymna the Weaver and Kraum, Ludevic's Opus" })).toEqual({ commander: "Tymna the Weaver", partner: "Kraum, Ludevic's Opus" });
    expect(splitPair({ commander_name: "Frodo", deck_label: "Food and Fellowship" })).toEqual({ commander: "Frodo", partner: undefined });
  });
});

describe("settleRebuilt", () => {
  it("gives a deck its name back when the partner read from it isn't a card", () => {
    expect(settleRebuilt({ commanderName: "Tymna the Weaver", partnerName: undefined }, true, "Tymna the Weaver and Friends")).toMatchObject({ partnerName: undefined, deckLabel: "Tymna the Weaver and Friends" });
  });

  it("keeps a real pair as a pair, and a seat with no partner as it was", () => {
    const pair = { commanderName: "Tymna the Weaver", partnerName: "Kraum, Ludevic's Opus" };
    expect(settleRebuilt(pair, true, "Tymna the Weaver and Kraum, Ludevic's Opus")).toEqual(pair);
    expect(settleRebuilt({ commanderName: "Atraxa, Praetors' Voice" }, false, "Atraxa, Praetors' Voice")).toEqual({ commanderName: "Atraxa, Praetors' Voice" });
  });
});
