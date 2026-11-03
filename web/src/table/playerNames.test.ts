import { describe, expect, it } from "vitest";
import type { GameRow, Playgroup } from "../api";
import { isPlaceholderName, suggestedPeople } from "./playerNames";

describe("player suggestions", () => {
  it("excludes exact numbered temporary labels while keeping real names", () => {
    for (const name of ["Player 2", " player 6 ", "GUEST 12", "Dude 2"]) expect(isPlaceholderName(name)).toBe(true);
    for (const name of ["Kelly", "Cassie", "Player One", "Dude", "Guest House", "Player 2 Smith"]) expect(isPlaceholderName(name)).toBe(false);
  });

  it("uses corrected Kelly, omits placeholders from every source and keeps member identities", () => {
    const member = (id: string, name: string) => ({ id, user_id: null, guest_name: name, display_name: name, handle: null });
    const group: Playgroup = { id: "g", name: "Magic Bros", owner_id: "me", join_code: "ABC", members: [member("m1", "Player 2"), member("m2", "Cassie"), member("m3", "Alex"), member("m4", "Alex")] };
    const other = { ...group, id: "other", members: [member("m5", "Guest 1"), member("m6", "Sam")] };
    const game = { started_at: "2026-11-01T01:00:00Z", seats: [
      { display_name: "Kelly", guest_name: "Dude 1" },
      { display_name: "Dude 2" }, { display_name: "Player 3" }, { display_name: "Cassie" },
      { display_name: "Computer", ai_kind: "phase-ai" },
    ] } as GameRow;
    const people = suggestedPeople({ id: "me", display_name: "Bryan" }, group, [group, other], [game]);
    expect(people.map((p) => p.name)).toEqual(["Cassie", "Alex", "Alex", "Sam", "Kelly"]);
    expect(people.slice(0, 3).map((p) => p.memberId)).toEqual(["m2", "m3", "m4"]);
    expect(people.at(-1)?.memberId).toBeUndefined();
  });
});
