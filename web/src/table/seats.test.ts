import { describe, expect, it } from "vitest";
import type { Playgroup } from "../api";
import { afterRemoving, applySeatPatch, commandersPatch, emptySeat, stillHolds, withHandles, fitSeatsToGroup, patchSeat, renameSeat, seatDeckLabel, type SeatDraft } from "./seats";

const me = { id: "u-me", display_name: "Bryan" };
const mine: SeatDraft = { ...emptySeat(), name: "Bryan", userId: "u-me", deckId: "d1", deckVersionId: "v1", commanderName: "Atraxa" };
const group: Playgroup = {
  id: "pg",
  name: "Friday",
  owner_id: "u-me",
  join_code: "ABC123",
  members: [
    { id: "m-me", user_id: "u-me", guest_name: null, display_name: "Bryan", handle: "saget" },
    { id: "m-jo", user_id: null, guest_name: "Jo", display_name: "Jo", handle: null },
    { id: "m-sam", user_id: "u-sam", guest_name: null, display_name: "Sam Smith", handle: "sam" },
  ],
};

describe("renameSeat", () => {
  it("typing someone else's name over your seat drops your account and deck", () => {
    expect(renameSeat(mine, "Sam", me)).toEqual({ name: "Sam", userId: undefined, deckId: undefined, deckVersionId: undefined });
  });

  it("keeps the seat yours while it still has your name, and leaves guest seats alone", () => {
    expect(renameSeat(mine, "Bryan ", me)).toEqual({ name: "Bryan " });
    expect(renameSeat(emptySeat(), "Sam", me)).toEqual({ name: "Sam" });
  });
});

describe("patchSeat", () => {
  it("claiming your account for one seat takes it off the other", () => {
    const seats = patchSeat([mine, { ...emptySeat(), name: "Sam" }], 1, { userId: "u-me", name: "Bryan" });
    expect(seats[1]).toMatchObject({ userId: "u-me", name: "Bryan" });
    expect(seats[0]).toMatchObject({ userId: undefined, deckId: undefined, name: "" });
  });

  it("someone found by their handle sits once", () => {
    const seats = patchSeat([{ ...emptySeat(), name: "Kim", handle: "kim" }, emptySeat()], 1, { name: "Kim", handle: "kim" });
    expect(seats.map((s) => s.handle)).toEqual([undefined, "kim"]);
    expect(seats[0]!.name).toBe("");
  });

  it("a playgroup member sits once", () => {
    const seats = patchSeat([{ ...emptySeat(), name: "Jo", memberId: "m-jo" }, emptySeat()], 1, { memberId: "m-jo", name: "Jo" });
    expect(seats.map((s) => s.memberId)).toEqual([undefined, "m-jo"]);
  });
});

describe("fitSeatsToGroup", () => {
  it("picks your own member row when a playgroup is chosen", () => {
    const [s] = fitSeatsToGroup([mine], group, me);
    expect(s).toMatchObject({ memberId: "m-me", userId: "u-me", deckVersionId: "v1" });
  });

  it("turns picks from another group into guests, and members into names without a group", () => {
    const other: SeatDraft = { ...emptySeat(), name: "Kim", memberId: "m-kim", userId: "u-kim" };
    expect(fitSeatsToGroup([other], group, me)[0]).toMatchObject({ name: "Kim", memberId: undefined, userId: undefined });
    const seats = fitSeatsToGroup([{ ...mine, memberId: "m-me" }, { ...emptySeat(), name: "Jo", memberId: "m-jo" }], undefined, me);
    expect(seats[0]).toMatchObject({ memberId: undefined, userId: "u-me", deckVersionId: "v1" });
    expect(seats[1]).toMatchObject({ memberId: undefined, userId: undefined, name: "Jo" });
  });

  it("someone found by their handle becomes their member row when they're in the group", () => {
    const found: SeatDraft = { ...emptySeat(), name: "@sam", handle: "sam", deckVersionId: "v-sam", deckLabel: "Riders of Rohan" };
    expect(fitSeatsToGroup([found], group, me)[0]).toMatchObject({ memberId: "m-sam", userId: "u-sam", name: "Sam Smith", deckLabel: "Riders of Rohan" });
    // Not in the group, or no group: still a guest named by the handle.
    const stranger: SeatDraft = { ...found, handle: "kim", name: "@kim" };
    expect(fitSeatsToGroup([stranger], group, me)[0]).toEqual(stranger);
    expect(fitSeatsToGroup([found], undefined, me)[0]).toEqual(found);
  });
});

describe("seatDeckLabel", () => {
  it("names the deck picked, else the commander, and a pair as both commanders", () => {
    expect(seatDeckLabel({ commanderName: "Éomer, King of Rohan", deckLabel: "Riders of Rohan" })).toBe("Riders of Rohan");
    expect(seatDeckLabel({ commanderName: "Atraxa, Praetors' Voice" })).toBe("Atraxa, Praetors' Voice");
    expect(seatDeckLabel({ commanderName: "Tymna the Weaver", partnerName: "Kraum, Ludevic's Opus", deckLabel: "Blood and ink" })).toBe("Tymna the Weaver and Kraum, Ludevic's Opus");
    expect(seatDeckLabel({ commanderName: "" })).toBeUndefined();
  });
});

describe("afterRemoving", () => {
  it("moves later seats up one and forgets the removed seat", () => {
    expect([0, 1, 2, 3].map((i) => afterRemoving(i, 1))).toEqual([0, null, 1, 2]);
    expect(afterRemoving(null, 0)).toBeNull();
  });
});

describe("commandersPatch", () => {
  const saved: SeatDraft = { ...emptySeat(), name: "Sam", commanderName: "Tymna the Weaver", partnerName: "Kraum, Ludevic's Opus", deckVersionId: "v-sam" };
  it("drops the deck a seat was saved with once its commanders change", () => {
    expect(commandersPatch(saved, { commanderName: "Atraxa, Praetors' Voice" })).toMatchObject({ commanderName: "Atraxa, Praetors' Voice", deckVersionId: undefined });
    expect(commandersPatch(saved, { commanderName: "Tymna the Weaver", partnerName: undefined })).toHaveProperty("deckVersionId", undefined);
  });

  it("keeps it while the commanders are the same (art and colors filled in)", () => {
    expect(commandersPatch(saved, { commanderName: "Tymna the Weaver", partnerName: "Kraum, Ludevic's Opus", art: "a.jpg" })).not.toHaveProperty("deckVersionId");
  });
});

describe("late lookups", () => {
  const picked: SeatDraft = { ...emptySeat(), name: "Sam", deckLabel: "Food and Fellowship", commanderName: "Frodo, Adventurous Hobbit", partnerName: "Sam, Loyal Attendant" };
  const art = (now: SeatDraft) => (stillHolds(now, picked) ? { art: "frodo.jpg" } : null);

  it("land on a seat that still holds the deck and commanders", () => {
    expect(applySeatPatch([picked], 0, art)[0]).toMatchObject({ art: "frodo.jpg" });
  });

  it("are dropped once the partner, the deck or the seat's occupant changed, or the seat is gone", () => {
    expect(applySeatPatch([{ ...picked, partnerName: undefined }], 0, art)[0]!.art).toBeUndefined();
    expect(applySeatPatch([{ ...picked, deckLabel: undefined }], 0, art)[0]!.art).toBeUndefined();
    // Seat four was removed and added back empty before the lookup finished.
    expect(applySeatPatch([emptySeat()], 0, art)[0]!.art).toBeUndefined();
    expect(applySeatPatch([picked], 3, art)).toEqual([picked]);
    expect(applySeatPatch([picked], -1, { name: "x" })).toEqual([picked]);
  });
});

describe("withHandles", () => {
  const other: Playgroup = { ...group, id: "pg2", name: "Sunday", members: [{ id: "m-kim", user_id: "u-kim", guest_name: null, display_name: "Kim", handle: "kim" }] };
  it("gives rebuilt seats their players' handles, so they're offered decks and sit once", () => {
    const seats = withHandles(
      [
        { ...emptySeat(), name: "Sam Smith", memberId: "m-sam", userId: "u-sam" },
        { ...emptySeat(), name: "kim" },
        { ...emptySeat(), name: "Jo", memberId: "m-jo" },
        { ...emptySeat(), name: "@pat", handle: "pat" },
      ],
      group,
      [group, other],
    );
    expect(seats.map((s) => s.handle)).toEqual(["sam", "kim", undefined, "pat"]);
  });
});
