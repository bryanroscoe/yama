import { describe, expect, it } from "vitest";
import { playRequest, playsPrecon, seatWho, type SeatPlan } from "./setup";

const me: SeatPlan = { kind: "me", deckId: "", difficulty: "Medium" };
const friend: SeatPlan = { kind: "friend", deckId: "", difficulty: "Medium" };
const computer: SeatPlan = { kind: "ai", deckId: "d2", difficulty: "Hard" };
const precon: SeatPlan = { kind: "ai", deckId: "d2", difficulty: "Easy", source: "precon", preconId: "counterpunch" };

describe("a new online game's request", () => {
  it("sends each seat's deck, a precon for the computer, and who goes first", () => {
    expect(playRequest([me, friend, computer, precon], 2, "pg", "d1")).toEqual({
      playgroup_id: "pg",
      first: 2,
      seats: [
        { kind: "me", deck_id: "d1", precon_id: null, difficulty: null },
        { kind: "friend", deck_id: null, precon_id: null, difficulty: null },
        { kind: "ai", deck_id: "d2", precon_id: null, difficulty: "Hard" },
        { kind: "ai", deck_id: null, precon_id: "counterpunch", difficulty: "Easy" },
      ],
    });
  });

  it("rolls for first unless a seat still in the game was chosen", () => {
    expect(playRequest([me, computer], null, "", "d1").first).toBeNull();
    // The chosen seat was removed since.
    expect(playRequest([me, computer], 3, "", "d1").first).toBeNull();
    expect(playRequest([me, computer], null, "", "d1").playgroup_id).toBeNull();
  });

  it("only the computer plays a precon, and only once one is picked", () => {
    expect(playsPrecon(precon)).toBe(true);
    expect(playsPrecon({ ...precon, preconId: "" })).toBe(false);
    expect(playsPrecon({ ...precon, kind: "friend" })).toBe(false);
    // A seat switched back to a friend keeps nothing of the precon.
    expect(playRequest([me, { ...precon, kind: "friend" }], null, "", "d1").seats[1]).toEqual({ kind: "friend", deck_id: null, precon_id: null, difficulty: null });
    // No precon picked yet: the computer plays your deck.
    expect(playRequest([me, { ...precon, preconId: "" }], null, "", "d1").seats[1]).toMatchObject({ deck_id: "d2", precon_id: null });
  });

  it("names seats for the first-player choice", () => {
    expect([me, friend, computer].map(seatWho)).toEqual(["You", "Seat 2, a friend", "Seat 3, the computer"]);
  });
});
