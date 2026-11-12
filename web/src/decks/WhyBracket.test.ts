import { describe, expect, it } from "vitest";
import { comboResult, gameChangersAt } from "./WhyBracket";

describe("Why this bracket", () => {
  it("strikes the Game Changers a swap bag takes out", () => {
    expect(gameChangersAt(["Demonic Tutor", "The One Ring"], new Set(["Demonic Tutor"]))).toEqual([
      { name: "Demonic Tutor", out: true },
      { name: "The One Ring", out: false },
    ]);
    expect(gameChangersAt(null, new Set())).toEqual([]);
  });

  it("sums up what a combo does in a line", () => {
    expect(comboResult(["Infinite mana", "Infinite storm count", "Infinite ETB", "Win"])).toBe("Infinite mana, Infinite storm count, and more.");
    expect(comboResult(["Infinite mana"])).toBe("Infinite mana.");
    expect(comboResult([])).toBe("");
  });
});
