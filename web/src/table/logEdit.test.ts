import { describe, expect, it } from "vitest";
import type { DeckSummary, GameDetail, GameSeat } from "../api";
import { formFromGame, isLoggedGame, settleRebuilt, splitPair } from "./logEdit";

const seat = (n: number, p: Partial<GameSeat>): GameSeat => ({
  seat: n, member_id: null, user_id: null, guest_name: null, deck_version_id: null, deck_label: null, commander_name: null,
  final_life: null, eliminated_turn: null, eliminated_by_seat: null, fun: null, display_name: null, ...p,
});

const game = (p: Partial<GameDetail>): GameDetail => ({
  id: "g", mode: "in_person", playgroup_id: null, status: "finished", started_at: "2026-10-20T20:00:00", ended_at: null, turns: 9,
  winner_seat: 2, first_seat: 1, win_condition: "combat", events: [], can_continue: false, can_edit: true, seats: [], ...p,
});

const myDeck = { id: "d1", name: "Riders of Rohan", color_identity: "RW", commander_image: "https://cards.scryfall.io/art.jpg", commander_artist: "Someone" } as unknown as DeckSummary;

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
