import { describe, expect, it } from "vitest";
import { queryChips, terms, withoutTerm } from "./cardQuery";

describe("queryChips", () => {
  it("reads common terms as words", () => {
    expect(queryChips("id<=wur t:creature o:create").map((c) => c.label)).toEqual(["Fits white, blue, red", "Creature", 'Says "create"']);
    expect(queryChips('o:"draw a card" mv<=2 -t:land').map((c) => c.label)).toEqual(['Says "draw a card"', "Mana value at most 2", "Not land"]);
    expect(queryChips("is:commander kw:flying pow>=4 sol").map((c) => c.label)).toEqual(["Can be your commander", "Has flying", "Power at least 4", 'Named "sol"']);
  });

  it("leaves a query with or or parentheses whole", () => {
    expect(queryChips("t:elf or t:goblin")).toEqual([]);
    expect(queryChips("(t:elf t:goblin) id<=g")).toEqual([]);
    expect(queryChips("   ")).toEqual([]);
  });

  it("takes one term out, keeping quoted text together", () => {
    expect(terms('o:"enters tapped" -o:"unless" id<=wr')).toEqual(['o:"enters tapped"', '-o:"unless"', "id<=wr"]);
    expect(withoutTerm('t:land o:"enters tapped" id<=wr', 'o:"enters tapped"')).toBe("t:land id<=wr");
  });
});
