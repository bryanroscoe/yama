import { describe, expect, it } from "vitest";
import { BACK_KEY, GATE_SAYS, gateStatus } from "./gateLoop";

// What the camera says for each of the placement gate's decisions (gateLoop.ts).

describe("what the camera says with the gate on", () => {
  it("asks for stillness while the card moves, and says it's reading once it rests", () => {
    expect(gateStatus({ kind: "none" }, false)).toBe("Hold a card in view");
    expect(gateStatus({ kind: "moving" }, false)).toBe("Hold the card still");
    expect(gateStatus({ kind: "steadying" }, false)).toBe("Hold still, reading the name");
    expect(gateStatus({ kind: "reading" }, false)).toBe("Hold still, reading the name");
  });

  it("says a card already read is done with, a back is a back, and when it has given up", () => {
    expect(gateStatus({ kind: "latched", key: "Sol Ring" }, false)).toBe("Ready for the next card");
    expect(gateStatus({ kind: "latched", key: BACK_KEY }, false)).toBe("Card back, turn the card over");
    expect(gateStatus({ kind: "no-match" }, false)).toBe(GATE_SAYS.noMatch);
    expect(GATE_SAYS.noMatch).toBe("No match, move the card");
  });

  it("only waits for the next card while the one just filed is still held", () => {
    for (const kind of ["none", "moving", "steadying", "reading"] as const) expect(gateStatus({ kind }, true)).toBe("Ready for the next card");
  });
});
