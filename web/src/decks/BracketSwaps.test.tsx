import { describe, expect, it } from "vitest";
import { boxBracket, bracketSwaps } from "./BracketSwaps";

const bag = (i: string, o: string) => ({ in: i, out: o });

describe("playing the box at a lower bracket", () => {
  it("adds each bag on top of the one above, highest bracket first", () => {
    const b = { target: 4, bags: { "2": [bag("Night's Whisper", "The One Ring")], "3": [bag("Stitch Together", "Demonic Tutor"), bag("Laughing Mad", "Vampiric Tutor")] } };
    const r = bracketSwaps(b);
    expect(r.map((x) => x.bracket)).toEqual([3, 2]);
    expect(r[0]!.swaps.map((s) => s.out)).toEqual(["Demonic Tutor", "Vampiric Tutor"]);
    expect(r[1]!.swaps.map((s) => s.out)).toEqual(["Demonic Tutor", "Vampiric Tutor", "The One Ring"]);
  });
  it("skips bags at or above the box's bracket, and empty ones", () => {
    expect(bracketSwaps({ target: 3, bags: { "3": [bag("a", "b")], "2": [] } })).toEqual([]);
    expect(bracketSwaps(null)).toEqual([]);
  });
  it("reads the box's bracket from box, then target", () => {
    expect(boxBracket({ target: 4, box: 3 })).toBe(3);
    expect(boxBracket({ target: 4 })).toBe(4);
    expect(boxBracket(null)).toBeNull();
  });
});
