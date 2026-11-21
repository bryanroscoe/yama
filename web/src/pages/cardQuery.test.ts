import { describe, expect, it } from "vitest";
import { didYouMean, editDistance, queryChips, searchErrorWords, terms, withoutTerm, wordsToLookUp } from "./cardQuery";

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

describe("a search that finds nothing or can't be read", () => {
  const names = ["Lightning Greaves", "Lightning Bolt", "Lightning Colt", "Sol Ring", "Fire // Ice", "Séance", "Bolt Bend"];

  it("offers the nearest card names for a misspelled one, nearest first", () => {
    expect(didYouMean("lightnig bolt", names)).toEqual(["Lightning Bolt", "Lightning Colt"]);
    expect(didYouMean("sol rnig", names)).toEqual(["Sol Ring"]);
    // Capitals, accents and punctuation don't count; one face of a two-faced card is enough.
    expect(didYouMean("SEANSE", names)).toEqual(["Séance"]);
    expect(didYouMean("fier", names)).toEqual(["Fire // Ice"]);
    expect(didYouMean("lightnig bolt", ["Emeritus of Conflict // Lightning Bolt", "Lightning Bolt"])).toEqual(["Lightning Bolt", "Emeritus of Conflict // Lightning Bolt"]);
    // Nothing near, or too little typed to guess from: no suggestion rather than a wild one.
    expect(didYouMean("counterspell", names)).toEqual([]);
    expect(didYouMean("so", names)).toEqual([]);
    expect(didYouMean("lightning", ["Lightning Bolt", "Lightning Bolt"])).toEqual([]);
    expect(didYouMean("lightnin bolt", ["Lightning Bolt", "Lightning Bolt"])).toEqual(["Lightning Bolt"]);
    expect(didYouMean("lightning bol", names, 1)).toEqual(["Lightning Bolt"]);
  });

  it("counts the letters between two names, giving up past the limit", () => {
    expect(editDistance("lightnig bolt", "lightning bolt", 3)).toBe(1);
    // Two neighbours swapped is one slip.
    expect(editDistance("sol rnig", "sol ring", 2)).toBe(1);
    expect(editDistance("abc", "abc", 1)).toBe(0);
    expect(editDistance("abc", "xyz", 1)).toBe(2);
    expect(editDistance("a", "abcdef", 2)).toBe(3);
  });

  it("looks up the longest words of a name when the device has no list of names", () => {
    expect(wordsToLookUp("lightnig bolt")).toEqual(["lightnig", "bolt"]);
    expect(wordsToLookUp("jace the mind sculpter")).toEqual(["sculpter", "jace"]);
    expect(wordsToLookUp("sol rin")).toEqual([]);
  });

  it("writes the parser's short errors as sentences", () => {
    expect(searchErrorWords("mv<= needs a value")).toBe("mv<= needs something after it, like mv<=3.");
    expect(searchErrorWords("t: needs a value")).toBe("t: needs something after it, like t:dragon.");
    expect(searchErrorWords("kw: needs a value")).toBe("kw: needs something after it.");
    expect(searchErrorWords("unsupported keyword foo:")).toBe('Yama\'s search doesn\'t have "foo:".');
    expect(searchErrorWords("unclosed quote")).toBe('A quote mark isn\'t closed. Add the closing " after the words.');
    expect(searchErrorWords("unknown color 'x'")).toBe('"x" isn\'t a color. Use the letters w, u, b, r, g and c.');
    expect(searchErrorWords("abc isn't a number")).toBe('"abc" isn\'t a number. Try mv<=3.');
    expect(searchErrorWords("missing ')'")).toBe("A ( isn't closed. Add the closing ).");
    // Every sentence starts with a capital or the term itself and ends with a full stop.
    for (const raw of ["unexpected ')'", "empty expression", "unexpected token", "unexpected end", "set takes : or =, not >", "unsupported is:foo", "unsupported operator !", "unknown rarity bad", "19 isn't a year", "x isn't a price", "a search can be at most 500 characters"]) {
      expect(searchErrorWords(raw), raw).toMatch(/\.$/);
    }
    // Not the parser's words: left to say its own piece.
    expect(searchErrorWords("Too many card searches from this address. Try again in a minute.")).toBeNull();
  });
});
