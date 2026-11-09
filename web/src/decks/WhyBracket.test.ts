import { describe, expect, it } from "vitest";
import { gameChangersAt } from "./WhyBracket";

describe("Why this bracket", () => {
  it("strikes the Game Changers a swap bag takes out", () => {
    expect(gameChangersAt(["Demonic Tutor", "The One Ring"], new Set(["Demonic Tutor"]))).toEqual([
      { name: "Demonic Tutor", out: true },
      { name: "The One Ring", out: false },
    ]);
    expect(gameChangersAt(null, new Set())).toEqual([]);
  });
});
