import { describe, expect, it } from "vitest";
import type { Playgroup } from "../api";
import { afterRemoving, applyDraftPatch, applySeatPatch, withDraftIds, commandersPatch, emptySeat, rebuildForGroup, stillHolds, withHandles, withoutGroup, fitSeatsToGroup, patchSeat, personPatch, renameSeat, seatDeckLabel, seatHolds, togglePerson, fitsSegmented, type SeatDraft } from "./seats";

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

  it("keeps a plain friend selected on an explicit group switch, including their deck", () => {
    const friend = { ...emptySeat(), name: " sam smith ", deckLabel: "Riders", deckVersionId: "v-sam", commanderName: "Éowyn" };
    const [seat] = fitSeatsToGroup([friend], group, me, true);
    expect(seat).toMatchObject({ ...friend, name: "Sam Smith", memberId: "m-sam", userId: "u-sam", handle: "sam" });
    expect(seatHolds(seat!, { name: "Sam Smith", memberId: "m-sam" })).toBe(true);
    expect(togglePerson([seat!], { name: "Sam Smith", memberId: "m-sam" }, {}, 6)).toEqual([emptySeat()]);
    // Rebuilding historical guest seats must not attach accounts by name.
    expect(rebuildForGroup([friend], group, me)).toEqual([friend]);
    const guest = { ...emptySeat(), name: "Jo" };
    expect(fitSeatsToGroup([guest], group, me, true)[0]).toMatchObject({ memberId: "m-jo", userId: undefined });
  });

  it("does not infer yourself, ambiguous names, duplicate seats or conflicting identities", () => {
    const sam = { ...emptySeat(), name: "Sam Smith" };
    const duplicateGroup = { ...group, members: [...group.members, { ...group.members[2]!, id: "m-other", user_id: "u-other" }] };
    expect(fitSeatsToGroup([sam], duplicateGroup, me, true)).toEqual([sam]);
    expect(fitSeatsToGroup([sam, sam], group, me, true)).toEqual([sam, sam]);
    const occupied = { ...sam, memberId: "m-sam", userId: "u-sam" };
    expect(fitSeatsToGroup([occupied, sam], group, me, true)).toEqual([occupied, sam]);
    for (const seat of [{ ...emptySeat(), name: "Bryan" }, { ...sam, userId: "u-stranger" }, { ...sam, memberId: "m-elsewhere" }, { ...sam, handle: "elsewhere" }]) {
      expect(fitSeatsToGroup([seat], group, me, true)[0]!.memberId).toBeUndefined();
    }
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

  it("leaves a guest alone when the name is more than one person's", () => {
    const third: Playgroup = { ...other, id: "pg3", members: [{ id: "m-kim2", user_id: "u-kim2", guest_name: null, display_name: "Kim", handle: "kimberly" }] };
    expect(withHandles([{ ...emptySeat(), name: "Kim" }], group, [group, other, third])[0]!.handle).toBeUndefined();
  });
});

describe("withoutGroup", () => {
  it("makes a playgroup you can't log in guests by name, keeping what they played", () => {
    const seats = withoutGroup(
      [
        { ...mine, memberId: "m-me" },
        { ...emptySeat(), name: "Sam Smith", memberId: "m-sam", userId: "u-sam", handle: "sam", deckLabel: "Riders of Rohan", commanderName: "Éowyn, Shieldmaiden" },
        { ...emptySeat(), name: "Jo", memberId: "m-jo" },
      ],
      me,
    );
    expect(seats[0]).toMatchObject({ memberId: undefined, userId: "u-me", deckId: "d1", deckVersionId: "v1" });
    expect(seats[1]).toMatchObject({ name: "Sam Smith", memberId: undefined, userId: undefined, handle: "sam", deckLabel: "Riders of Rohan", commanderName: "Éowyn, Shieldmaiden" });
    expect(seats[2]).toMatchObject({ name: "Jo", memberId: undefined });
  });
});

describe("rebuildForGroup", () => {
  it("finds a returning member's new row, and makes anyone no longer in the group a guest who keeps their deck", () => {
    const seats = rebuildForGroup(
      [
        // Sam left (the seat lost its member row) and rejoined as m-sam.
        { ...emptySeat(), name: "Sam Smith", userId: "u-sam", deckVersionId: "v-sam", deckLabel: "Riders of Rohan" },
        { ...emptySeat(), name: "Jo", memberId: "m-jo" },
        // Kim left and didn't come back.
        { ...emptySeat(), name: "Kim", userId: "u-kim", handle: "kim", deckLabel: "Food and Fellowship" },
        { ...emptySeat(), name: "Guest" },
      ],
      group,
      me,
    );
    expect(seats[0]).toMatchObject({ memberId: "m-sam", userId: "u-sam", deckVersionId: "v-sam", deckLabel: "Riders of Rohan" });
    expect(seats[1]).toMatchObject({ memberId: "m-jo" });
    expect(seats[2]).toMatchObject({ name: "Kim", userId: undefined, memberId: undefined, handle: "kim", deckLabel: "Food and Fellowship" });
    expect(seats[3]).toMatchObject({ name: "Guest" });
  });
});

describe("togglePerson (Who's playing)", () => {
  const me = { id: "u1", display_name: "Bryan" };
  const group = { id: "pg", name: "Friday", owner_id: "u1", join_code: "X", members: [
    { id: "m-me", user_id: "u1", display_name: "Bryan", handle: null },
    { id: "m-sam", user_id: "u2", display_name: "Sam", handle: "sam" },
    { id: "m-jo", user_id: null, display_name: "Jo", handle: null },
  ] } as unknown as Playgroup;
  const sam = { name: "Sam", memberId: "m-sam", userId: "u2" };
  const jo = { name: "Jo", memberId: "m-jo" };
  const start = (): SeatDraft[] => [{ ...emptySeat(), name: "Bryan", memberId: "m-me", userId: "u1" }, emptySeat(), emptySeat()];

  it("seats people in the open seats in tap order, then adds seats up to the most", () => {
    let s = togglePerson(start(), sam, personPatch(sam, group, me)!, 4);
    s = togglePerson(s, jo, personPatch(jo, group, me)!, 4);
    expect(s.map((x) => x.name)).toEqual(["Bryan", "Sam", "Jo"]);
    expect(s[1]).toMatchObject({ memberId: "m-sam", userId: "u2", handle: "sam" });
    const alex = { name: "Alex" };
    s = togglePerson(s, alex, personPatch(alex, group, me)!, 4);
    expect(s.map((x) => x.name)).toEqual(["Bryan", "Sam", "Jo", "Alex"]);
    // Full: nobody else fits.
    expect(togglePerson(s, { name: "Kim" }, { name: "Kim" }, 4)).toBe(s);
  });

  it("a second tap removes their seat and lowers the count, keeping other decks", () => {
    let s = togglePerson(start(), sam, personPatch(sam, group, me)!, 6);
    s = togglePerson(s, jo, personPatch(jo, group, me)!, 6);
    s = patchSeat(s, 2, { deckLabel: "Jo's deck", commanderName: "Atraxa" });
    const remaining = s[2];
    s = togglePerson(s, sam, personPatch(sam, group, me)!, 6);
    expect(s.map((x) => x.name)).toEqual(["Bryan", "Jo"]);
    expect(s[1]).toBe(remaining);
    s = togglePerson(s, { name: "Alex" }, { name: "Alex" }, 6);
    expect(s.map((x) => x.name)).toEqual(["Bryan", "Jo", "Alex"]);
    expect(seatHolds(s[2]!, { name: "alex" })).toBe(true);
  });

  it("decreases from six seats and keeps one editable seat when the last person leaves", () => {
    const people = ["A", "B", "C", "D", "E", "F"].map((name) => ({ ...emptySeat(), name }));
    let s = togglePerson(people, { name: "F" }, {}, 6);
    expect(s).toHaveLength(5);
    s = togglePerson(s, { name: "A" }, {}, 6);
    expect(s.map((x) => x.name)).toEqual(["B", "C", "D", "E"]);
    expect(togglePerson([people[0]!], { name: "A" }, {}, 6)).toEqual([emptySeat()]);
    expect(togglePerson([emptySeat()], { name: "A" }, { name: "A" }, 6)).toEqual([people[0]]);
  });

  it("without a playgroup a friend sits as a guest by name, and only you keep your account", () => {
    expect(personPatch(sam, undefined, me)).toMatchObject({ name: "Sam", memberId: undefined, userId: undefined });
    expect(personPatch({ name: "Bryan", userId: "u1" }, undefined, me)).toMatchObject({ userId: "u1" });
  });
});


describe("setup draft identities", () => {
  it("lets a pending partner lookup follow a surviving seat after another player leaves", async () => {
    let seats = withDraftIds([
      { ...emptySeat(), name: "Jo" },
      { ...emptySeat(), name: "Sam", commanderName: "Frodo, Adventurous Hobbit", deckLabel: "Food and Fellowship" },
    ]);
    const id = seats[1]!.draftId!;
    let resolve!: (patch: Partial<SeatDraft>) => void;
    const answer = new Promise<Partial<SeatDraft>>((done) => { resolve = done; }).then((patch) => {
      seats = applyDraftPatch(seats, id, (now) => now.commanderName === "Frodo, Adventurous Hobbit" ? patch : null);
    });
    seats = withDraftIds(togglePerson(seats, { name: "Jo" }, {}, 6));
    resolve({ partnerName: "Sam, Loyal Attendant" });
    await answer;
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ name: "Sam", draftId: id, partnerName: "Sam, Loyal Attendant", deckLabel: "Food and Fellowship" });
  });

  it("drops answers for a removed seat even when its replacement has the same commanders", () => {
    const [removed] = withDraftIds([{ ...emptySeat(), name: "Sam", commanderName: "Atraxa" }]);
    const seats = withDraftIds(togglePerson([removed!], { name: "Sam" }, {}, 6));
    const replacement = patchSeat(seats, 0, { name: "Jo", commanderName: "Atraxa" });
    expect(applyDraftPatch(replacement, removed!.draftId!, { art: "old.jpg" })).toBe(replacement);
  });

  it("preserves surviving ids and gives added, restored and duplicate-id seats their own identity", () => {
    const seats = withDraftIds([emptySeat(), emptySeat()]);
    expect(seats[0]!.draftId).not.toBe(seats[1]!.draftId);
    expect(withDraftIds(seats)).toEqual(seats);
    const copies = withDraftIds([seats[0]!, seats[0]!]);
    expect(copies[0]!.draftId).not.toBe(copies[1]!.draftId);
  });
});

describe("fitsSegmented", () => {
  it("keeps two or three short choices as pills", () => {
    expect(fitsSegmented([{ label: "Main list" }, { label: "Stock" }])).toBe(true);
    expect(fitsSegmented([{ label: "Main list" }, { label: "Stock" }, { label: "Bracket 2" }])).toBe(true);
  });
  it("turns many or long choices into a dropdown", () => {
    const lists = ["Main list", "Stock — Invisible Woman", "Bracket 2", "Bracket 3", "Bracket 4", "After prints", "Stock"].map((label) => ({ label }));
    expect(fitsSegmented(lists)).toBe(false);
    expect(fitsSegmented([{ label: "Main list" }, { label: "Stock — Invisible Woman" }])).toBe(false);
    expect(fitsSegmented(["A", "B", "C", "D"].map((label) => ({ label })))).toBe(false);
  });
});
