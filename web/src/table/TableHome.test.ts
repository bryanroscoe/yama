import { describe, expect, it } from "vitest";
import { savedFromState, savedStanding } from "./TableHome";

describe("the game just saved, on the life counter's setup page", () => {
  it("reads who won from the way back from the table", () => {
    expect(savedFromState({ saved: { gameId: "g1", winner: " Kelly " } })).toEqual({ gameId: "g1", winner: "Kelly" });
    expect(savedFromState({ saved: { gameId: "g1" } })).toEqual({ gameId: "g1", winner: null });
    expect(savedFromState(null)).toBeNull();
    expect(savedFromState({ saved: { gameId: "" } })).toBeNull();
  });

  it("links to the game only once Yama has it", () => {
    expect(savedStanding("g1", false, [], [])).toBe("page");
    // Still to upload: saved, with no page to open yet.
    expect(savedStanding("g1", false, ["g1"], [])).toBe("waiting");
    expect(savedStanding("g1", false, ["g2"], ["g3"])).toBe("page");
    // No account: it stays on this device.
    expect(savedStanding("g1", true, [], [])).toBe("device");
  });

  it("isn't called saved once Yama has refused it", () => {
    // Out of the upload list and into the refused one: it used to read "Saved… See the game".
    expect(savedStanding("g1", false, [], ["g1"])).toBe("refused");
    expect(savedStanding("g1", false, ["g1"], ["g1"])).toBe("refused");
  });
});
