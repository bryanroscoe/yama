import { describe, expect, it } from "vitest";
import { queryChips, terms, withoutTerm } from "./cardQuery";

describe("queryChips", () => {
  it("reads common terms as words", () => {
    expect(queryChips("id<=wur t:creature o:create").map((c) => c.label)).toEqual(["Fits white, blue, red", "Creature", 'Says "create"']);
    expect(queryChips('o:"draw a card" mv<=2 -t:land').map((c) => c.label)).toEqual(['Says "draw a card"', "Mana value at most 2", "Not land"]);
    expect(queryChips("is:commander kw:flying pow>=4 sol").map((c) => c.label)).toEqual(["Can be your commander", "Has flying", "Power at least 4", 'Named "sol"']);
  });

  it("reads sets, artists, years, prices and the newer is: values as words", () => {
    expect(queryChips('set:cmm a:"rebecca guay" year>=2020').map((c) => c.label)).toEqual(["From CMM", "Art by rebecca guay", "Printed in 2020 or later"]);
    expect(queryChips("year:1994 year<2000 -year>2020").map((c) => c.label)).toEqual(["Printed in 1994", "Printed before 2000", "Not printed after 2020"]);
    expect(queryChips("usd<5 usd>=$2.50 usd:1").map((c) => c.label)).toEqual(["Price under $5", "Price at least $2.50", "Price $1"]);
    expect(queryChips("is:reserved is:partner -is:mdfc is:saga").map((c) => c.label)).toEqual(["On the Reserve List", "Partners or pairs with a Background", "Not modal double-faced", "Saga"]);
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
