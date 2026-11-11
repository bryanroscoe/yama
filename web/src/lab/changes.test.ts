import { describe, expect, it } from "vitest";
import { addsAndCuts, changeProblems, listDiff, stillIn, swap, swapCount, swapsFrom, swapText } from "./changes";
import type { BaseLine } from "./logic";

const base: BaseLine[] = [
  { name: "Omo, Queen of Vesuva", qty: 1, board: "commander" },
  { name: "Sol Ring", qty: 1, board: "main" },
  { name: "Ponder", qty: 1, board: "main" },
  { name: "Island", qty: 50, board: "main" },
  { name: "Forest", qty: 47, board: "main" },
  { name: "Sideboard Thing", qty: 1, board: "side" },
];

describe("swaps", () => {
  it("send one add and one cut per copy, pairs or not", () => {
    const s = [swap("Ponder", "Brainstorm"), swap("Island", null), swap(null, "Arcane Signet")];
    expect(addsAndCuts(s)).toEqual({ add: ["Brainstorm", "Arcane Signet"], cut: ["Ponder", "Island"] });
    expect(swapText(s)).toBe("Ponder → Brainstorm, −Island, +Arcane Signet");
  });

  it("count the changed list without the sideboard", () => {
    expect(swapCount(base, [])).toBe(100);
    expect(swapCount(base, [swap("Ponder", "Brainstorm")])).toBe(100);
    expect(swapCount(base, [swap("Ponder", null)])).toBe(99);
    expect(swapCount(base, [swap(null, "Brainstorm")])).toBe(101);
  });

  it("know how many copies are left to cut", () => {
    expect(stillIn(base, [swap("Island", "Mystic Sanctuary"), swap("Island", null)], "Island")).toBe(48);
    expect(stillIn(base, [], "Omo, Queen of Vesuva")).toBe(0);
  });

  it("pair up adds and cuts that came without pairs, plan pairs first", () => {
    const s = swapsFrom(["Brainstorm", "Arcane Signet", "Cultivate"], ["Island", "Ponder"], [["Ponder", "Brainstorm"]]);
    expect(s.map((x) => [x.out, x.in])).toEqual([
      ["Ponder", "Brainstorm"],
      ["Island", "Arcane Signet"],
      [null, "Cultivate"],
    ]);
  });

  it("turn one list into another as swaps", () => {
    const after: BaseLine[] = base.map((l) => (l.name === "Ponder" ? { ...l, name: "Brainstorm" } : l.name === "Island" ? { ...l, qty: 49 } : l));
    after.push({ name: "Mystic Sanctuary", qty: 1, board: "main" });
    const s = listDiff(base, after, [["Island", "Mystic Sanctuary"]]);
    expect(s.map((x) => [x.out, x.in]).sort()).toEqual([
      ["Island", "Mystic Sanctuary"],
      ["Ponder", "Brainstorm"],
    ]);
  });
});

describe("changeProblems", () => {
  it("blocks only on the count, and says how to even it", () => {
    expect(changeProblems(base, [swap("Ponder", "Brainstorm")], "UG")).toEqual({ blocking: [], warnings: [] });
    const short = changeProblems(base, [swap("Ponder", null)], "UG");
    expect(short.blocking[0]).toMatch(/99 cards.*Add 1/);
    const long = changeProblems(base, [swap(null, "Brainstorm")], "UG");
    expect(long.blocking[0]).toMatch(/101 cards.*Cut 1/);
  });

  it("warns about cards outside the commander's colours", () => {
    const p = changeProblems(base, [swap("Ponder", "Lightning Bolt", { inCard: { color_identity: "R" } })], "UG");
    expect(p.blocking).toEqual([]);
    expect(p.warnings).toEqual(["Lightning Bolt is outside the commander's colors."]);
    // Colourless fits anything; unknown colours aren't flagged.
    expect(changeProblems(base, [swap("Ponder", "Arcane Signet", { inCard: { color_identity: "" } })], "UG").warnings).toEqual([]);
    expect(changeProblems(base, [swap("Ponder", "Mystery")], "UG").warnings).toEqual([]);
  });

  it("warns about second copies, but not basics or any-number cards", () => {
    expect(changeProblems(base, [swap("Ponder", "Sol Ring")], "UG").warnings).toEqual(["Sol Ring would be in the list 2 times; Commander allows one copy."]);
    // Swapping the only copy out and back in is fine.
    expect(changeProblems(base, [swap("Sol Ring", "Sol Ring")], "UG").warnings).toEqual([]);
    expect(changeProblems(base, [swap("Ponder", "Island", { inCard: { type_line: "Basic Land — Island" } })], "UG").warnings).toEqual([]);
    expect(changeProblems(base, [swap("Ponder", "Relentless Rats"), swap("Sol Ring", "Relentless Rats")], "UG").warnings).toEqual([]);
  });
});
