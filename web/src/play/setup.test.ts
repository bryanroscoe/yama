import { describe, expect, it, vi } from "vitest";
import { forgetJoinCode, joinDeck, keepJoinCode, keptJoinCode, nextDeck, playRequest, playsPrecon, recentDecks, rememberedSeats, seatWho, startingSeats, withPrecons, type SeatPlan } from "./setup";

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

  it("your seat can play a precon too, as a guest's always does", () => {
    const mine: SeatPlan = { ...me, source: "precon", preconId: "counterpunch" };
    expect(playsPrecon(mine)).toBe(true);
    expect(playRequest([mine, precon], null, "", "").seats[0]).toEqual({ kind: "me", deck_id: null, precon_id: "counterpunch", difficulty: null });
  });

  it("with no decks of your own, every seat but a friend's gets a precon", () => {
    const filled = withPrecons([me, friend, computer, { ...precon, preconId: "a" }], ["a", "b", "c"], true);
    expect(filled.map((s) => s.preconId ?? null)).toEqual(["c", null, "b", "a"]);
    // A precon remembered from an earlier game that is no longer listed gives way to one that is.
    expect(withPrecons([me, { ...precon, preconId: "gone" }], ["a", "b", "c"], false)[1]!.preconId).toBe("a");
    expect(filled.every((s) => s.kind === "friend" || playsPrecon(s))).toBe(true);
    // With decks, a seat stays on its deck until it is set to precons.
    expect(withPrecons([me, computer], ["a"], false)).toEqual([me, computer]);
    expect(withPrecons([me, { ...computer, source: "precon" }], ["a", "b"], false)[1]!.preconId).toBe("a");
    // Before the precon list arrives nothing changes.
    expect(withPrecons([me], [], true)).toEqual([me]);
  });

  it("only a seat that isn't a friend's plays a precon, and only once one is picked", () => {
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

describe("the seats a new game opens with", () => {
  const decks = [
    { id: "aura", updated_at: "2026-10-01T00:00:00Z", parent_id: null },
    { id: "bats", updated_at: "2026-11-20T00:00:00Z", parent_id: null },
    { id: "cats", updated_at: "2026-11-05T00:00:00Z", parent_id: null },
    // Another list of Bats, changed last: it isn't a different deck to sit a seat on.
    { id: "bats-stock", updated_at: "2026-11-21T00:00:00Z", parent_id: "bats" },
  ];

  it("orders your decks by the last change, main lists only", () => {
    expect(recentDecks(decks)).toEqual(["bats", "cats", "aura"]);
    // Only configurations: better those than nothing.
    expect(recentDecks([decks[3]!])).toEqual(["bats-stock"]);
    expect(recentDecks([])).toEqual([]);
  });

  it("sits each seat on a different deck, coming round again once all are taken", () => {
    const seats = startingSeats(decks, null);
    expect(seats.map((s) => s.kind)).toEqual(["me", "ai", "ai", "ai"]);
    // Three decks for four seats: no repeat until the fourth.
    expect(seats.map((s) => s.deckId)).toEqual(["bats", "cats", "aura", "bats"]);
    expect(nextDeck(["a", "b"], ["a"], 0)).toBe("b");
    expect(nextDeck(["a", "b"], ["a", "b"], 3)).toBe("b");
    // No decks (a guest, a new account): the seats play precons (withPrecons).
    expect(startingSeats([], null).map((s) => s.deckId)).toEqual(["", "", "", ""]);
    expect(nextDeck([], [], 2)).toBe("");
  });

  it("keeps the table you set up last time, replacing a deck you no longer have", () => {
    const last: SeatPlan[] = [
      { kind: "me", deckId: "cats", difficulty: "Medium" },
      { kind: "friend", deckId: "aura", difficulty: "Medium" },
      { kind: "ai", deckId: "deleted", difficulty: "Easy" },
      { kind: "ai", deckId: "bats-stock", difficulty: "Hard", source: "precon", preconId: "counterpunch" },
    ];
    const seats = startingSeats(decks, rememberedSeats(JSON.stringify(last)));
    // Yours and the chosen list stay; the deleted one becomes the newest deck nobody is on; a
    // friend's seat holds no deck (so it takes none from the others).
    expect(seats.map((s) => s.deckId)).toEqual(["cats", "", "bats", "bats-stock"]);
    expect(seats.map((s) => s.difficulty)).toEqual(["Medium", "Medium", "Easy", "Hard"]);
    expect(seats[3]).toMatchObject({ source: "precon", preconId: "counterpunch" });
  });

  it("a precon a seat had only for want of decks isn't brought back once you have one", () => {
    const precons = ["a", "b", "c"];
    // A new account: every seat is given a precon. They pick one for themselves and one for the
    // computer in seat 2 (a choice of opponent), and what they set is what's kept.
    const set: SeatPlan[] = [
      { kind: "me", deckId: "", difficulty: "Medium", preconId: "b" },
      { kind: "ai", deckId: "", difficulty: "Medium", source: "precon", preconId: "c" },
      { kind: "ai", deckId: "", difficulty: "Hard" },
    ];
    const kept = rememberedSeats(JSON.stringify(set));
    expect(kept).toEqual(set);
    // Still no decks: the precons they picked stay, and the untouched seat gets one as before.
    expect(withPrecons(startingSeats([], kept), precons, true).map((s) => s.preconId)).toEqual(["b", "c", "b"]);
    // A deck added since: they play it, and so does the computer nobody chose a precon for.
    const later = withPrecons(startingSeats(decks, kept), precons, false);
    expect(later.map(playsPrecon)).toEqual([false, true, false]);
    expect(later.map((s) => (playsPrecon(s) ? s.preconId : s.deckId))).toEqual(["bats", "c", "aura"]);
    // What a forced table used to keep (every seat marked as a precon) is what must not be saved:
    // it would sit you on a precon for good.
    expect(withPrecons(startingSeats(decks, rememberedSeats(JSON.stringify(withPrecons(set, precons, true)))), precons, false).every(playsPrecon)).toBe(true);
  });

  it("joins on the deck picked, else the last one played, else the newest, as the list is now", () => {
    const last: SeatPlan = { kind: "me", deckId: "cats", difficulty: "Medium" };
    expect(joinDeck(decks, null, undefined)).toBe("bats");
    expect(joinDeck(decks, null, last)).toBe("cats");
    expect(joinDeck(decks, "aura", last)).toBe("aura");
    // Last time was a precon, or a deck since deleted: the newest.
    expect(joinDeck(decks, null, { ...last, source: "precon", preconId: "a" })).toBe("bats");
    expect(joinDeck(decks, "deleted", { ...last, deckId: "gone" })).toBe("bats");
    // The list hasn't arrived (or is still the cached empty one), then does.
    expect(joinDeck([], null, last)).toBe("");
    expect(joinDeck([decks[2]!], null, undefined)).toBe("cats");
  });

  it("keeps a table code per account, until it is forgotten", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    });
    try {
      keepJoinCode("u1", "ABCD");
      expect(keptJoinCode("u1")).toBe("ABCD");
      // Another account on the same tab wasn't the one invited; nobody signed in keeps nothing.
      expect(keptJoinCode("u2")).toBe("");
      keepJoinCode(undefined, "WXYZ");
      expect(keptJoinCode(undefined)).toBe("");
      expect(kept.size).toBe(1);
      forgetJoinCode("u2");
      expect(keptJoinCode("u1")).toBe("ABCD");
      forgetJoinCode("u1");
      expect(keptJoinCode("u1")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("trusts nothing odd in what was kept", () => {
    expect(rememberedSeats(null)).toBeNull();
    expect(rememberedSeats("not json")).toBeNull();
    expect(rememberedSeats(JSON.stringify([{ kind: "me", deckId: "a", difficulty: "Easy" }]))).toBeNull();
    // Seat 1 is you, and nobody else is.
    expect(rememberedSeats(JSON.stringify([{ kind: "ai", deckId: "a" }, { kind: "ai", deckId: "b" }]))).toBeNull();
    expect(rememberedSeats(JSON.stringify([{ kind: "me", deckId: "a" }, { kind: "me", deckId: "b" }]))).toBeNull();
    expect(rememberedSeats(JSON.stringify([{ kind: "me", deckId: 7, difficulty: "Brutal" }, { kind: "ai", source: "precon", preconId: "" }]))).toEqual([
      { kind: "me", deckId: "", difficulty: "Medium" },
      { kind: "ai", deckId: "", difficulty: "Medium" },
    ]);
  });
});
