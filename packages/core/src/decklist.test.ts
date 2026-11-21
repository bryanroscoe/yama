import { describe, expect, it } from "vitest";
import { addToList, countInList, hasConsidering, listText, parseDeckList, removeFromList } from "./decklist";

const LIST = ["Commander", "1 Atraxa, Praetors' Voice", "", "Deck", "1 Sol Ring (CMM) 410 *F*", "2x Forest", "// ramp", "Arcane Signet", "", "Sideboard", "1 Negate"].join("\n");

describe("parseDeckList", () => {
  it("reads headings, counts, set codes and bare names", () => {
    expect(parseDeckList(LIST)).toEqual([
      { qty: 1, name: "Atraxa, Praetors' Voice", board: "commander" },
      { qty: 1, name: "Sol Ring", board: "main" },
      { qty: 2, name: "Forest", board: "main" },
      { qty: 1, name: "Arcane Signet", board: "main" },
      { qty: 1, name: "Negate", board: "side" },
    ]);
  });

  it("round-trips what listText writes", () => {
    const cards = [
      { qty: 1, name: "Omo, Queen of Vesuva", board: "commander" },
      { qty: 3, name: "Island", board: "main" },
      { qty: 1, name: "Negate", board: "side" },
    ];
    expect(parseDeckList(listText(cards))).toEqual(cards);
  });
});

describe("the Considering list", () => {
  const WITH = `${LIST}\n\nConsidering\n1 Swan Song\n2 Opt`;

  it("reads Considering and Maybeboard headings as their own board, not the sideboard", () => {
    expect(parseDeckList(WITH).filter((l) => l.board === "maybe")).toEqual([
      { qty: 1, name: "Swan Song", board: "maybe" },
      { qty: 2, name: "Opt", board: "maybe" },
    ]);
    expect(parseDeckList("1 Sol Ring\n// Maybeboard\n1 Opt").map((l) => l.board)).toEqual(["main", "maybe"]);
    expect(parseDeckList("1 Sol Ring\nSideboard\n1 Opt").map((l) => l.board)).toEqual(["main", "side"]);
  });

  it("knows whether a list has the section at all, even an empty one", () => {
    expect(hasConsidering(WITH)).toBe(true);
    expect(hasConsidering("Deck\n1 Sol Ring\n\nConsidering\n")).toBe(true);
    expect(hasConsidering("1 Sol Ring\r\n# Maybeboard:\r\n")).toBe(true);
    expect(hasConsidering(LIST)).toBe(false);
    // A card with the word in its name isn't a heading.
    expect(hasConsidering("1 Considering Options")).toBe(false);
  });

  it("writes it as its own section, after the sideboard", () => {
    const cards = [
      { qty: 1, name: "Omo, Queen of Vesuva", board: "commander" },
      { qty: 1, name: "Opt", board: "maybe" },
      { qty: 3, name: "Island", board: "main" },
    ];
    expect(listText(cards)).toBe("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n3 Island\n\nConsidering\n1 Opt");
    expect(parseDeckList(listText(cards)).map((l) => `${l.name} ${l.board}`).sort()).toEqual(["Island main", "Omo, Queen of Vesuva commander", "Opt maybe"]);
  });

  it("adds to it under its heading, and removes from the deck before it", () => {
    expect(addToList(LIST, "Opt", "maybe")).toBe(`${LIST}\n\nConsidering\n1 Opt`);
    expect(countInList(addToList(WITH, "Opt", "maybe"), "Opt", "maybe")).toBe(3);
    const both = addToList(WITH, "Swan Song");
    expect(countInList(removeFromList(both, "Swan Song"), "Swan Song", "maybe")).toBe(1);
    expect(countInList(removeFromList(removeFromList(both, "Swan Song"), "Swan Song"), "Swan Song")).toBe(0);
    expect(countInList(removeFromList(both, "Swan Song", "maybe"), "Swan Song", "main")).toBe(1);
  });
});

describe("countInList", () => {
  it("counts a card's copies on every board, or on one", () => {
    expect(countInList(LIST, "Forest")).toBe(2);
    expect(countInList(LIST, "forest")).toBe(2);
    expect(countInList(LIST, "Negate")).toBe(1);
    expect(countInList(LIST, "Negate", "main")).toBe(0);
    expect(countInList(LIST, "Counterspell")).toBe(0);
  });

  it("matches a double-faced card written by its front face, and the other way", () => {
    expect(countInList("1 Fable of the Mirror-Breaker", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki")).toBe(1);
    expect(countInList("1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "Fable of the Mirror-Breaker")).toBe(1);
  });
});

describe("addToList", () => {
  it("adds a new card after the main deck's last card, leaving every other line as typed", () => {
    const next = addToList(LIST, "Counterspell");
    expect(next.split("\n")).toEqual(["Commander", "1 Atraxa, Praetors' Voice", "", "Deck", "1 Sol Ring (CMM) 410 *F*", "2x Forest", "// ramp", "Arcane Signet", "1 Counterspell", "", "Sideboard", "1 Negate"]);
    expect(countInList(next, "Counterspell", "main")).toBe(1);
  });

  it("adds a copy to the line that names the card, keeping its set code and marks", () => {
    expect(addToList(LIST, "Forest")).toContain("3x Forest");
    expect(addToList(LIST, "Sol Ring")).toContain("2 Sol Ring (CMM) 410 *F*");
    expect(addToList(LIST, "Arcane Signet")).toContain("2 Arcane Signet");
  });

  it("puts a card that is only in the sideboard into the main deck too", () => {
    const next = addToList(LIST, "Negate");
    expect(countInList(next, "Negate", "main")).toBe(1);
    expect(countInList(next, "Negate", "side")).toBe(1);
  });

  it("starts a list, and writes under a heading that has no cards yet", () => {
    expect(addToList("", "Sol Ring")).toBe("1 Sol Ring");
    expect(addToList("Commander\n1 Omo, Queen of Vesuva\n", "Sol Ring")).toBe("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring\n");
    expect(addToList("Commander\n1 Omo, Queen of Vesuva", "Sol Ring")).toBe("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring");
    expect(addToList("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n\nSideboard\n1 Negate", "Sol Ring")).toBe("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring\n\nSideboard\n1 Negate");
    expect(addToList("1 Island\n1 Forest\n", "Sol Ring")).toBe("1 Island\n1 Forest\n1 Sol Ring\n");
  });

  it("keeps a file's own line endings and its last line break", () => {
    const crlf = "Commander\r\n1 Omo, Queen of Vesuva\r\n\r\nDeck\r\n1 Island\r\n";
    expect(addToList(crlf, "Sol Ring")).toBe("Commander\r\n1 Omo, Queen of Vesuva\r\n\r\nDeck\r\n1 Island\r\n1 Sol Ring\r\n");
    expect(removeFromList(addToList(crlf, "Sol Ring"), "Sol Ring")).toBe(crlf);
    expect(addToList("Commander\r\n1 Omo, Queen of Vesuva\r\n", "Sol Ring")).toBe("Commander\r\n1 Omo, Queen of Vesuva\r\n\r\nDeck\r\n1 Sol Ring\r\n");
  });

  it("adds to another board under its own heading", () => {
    expect(addToList("1 Island", "Negate", "side")).toBe("1 Island\n\nSideboard\n1 Negate");
    expect(countInList(addToList(LIST, "Swan Song", "side"), "Swan Song", "side")).toBe(1);
  });
});

describe("removeFromList", () => {
  it("takes one copy, dropping a line left with none", () => {
    expect(removeFromList(LIST, "Forest")).toContain("1x Forest");
    expect(countInList(removeFromList(LIST, "Sol Ring"), "Sol Ring")).toBe(0);
    expect(removeFromList(LIST, "Arcane Signet").split("\n")).not.toContain("Arcane Signet");
  });

  it("takes from the main deck before the sideboard, and leaves a list without the card alone", () => {
    const both = addToList(LIST, "Negate");
    const once = removeFromList(both, "Negate");
    expect(countInList(once, "Negate", "main")).toBe(0);
    expect(countInList(once, "Negate", "side")).toBe(1);
    expect(countInList(removeFromList(once, "Negate"), "Negate")).toBe(0);
    expect(removeFromList(LIST, "Counterspell")).toBe(LIST);
  });

  it("undoes an add exactly", () => {
    expect(removeFromList(addToList(LIST, "Counterspell"), "Counterspell")).toBe(LIST);
    expect(removeFromList(addToList(LIST, "Forest"), "Forest")).toBe(LIST);
  });
});

describe("a hand-typed list", () => {
  it("ends the Commander section at the blank line after its cards, as the server does", () => {
    const boards = (text: string) => parseDeckList(text).map((l) => `${l.board}: ${l.name}`);
    expect(boards("Commander\n1 Meren of Clan Nel Toth\n\n1 Sol Ring\n1 Forest")).toEqual(["commander: Meren of Clan Nel Toth", "main: Sol Ring", "main: Forest"]);
    // Two partners on adjoining lines both lead; a line of spaces is a blank line too.
    expect(boards("Commanders:\n1 Thrasios, Triton Hero\n1 Tymna the Weaver\n  \n1 Sol Ring")).toEqual(["commander: Thrasios, Triton Hero", "commander: Tymna the Weaver", "main: Sol Ring"]);
    // A blank line between the heading and its first card doesn't end the section.
    expect(boards("Commander\n\n1 Meren of Clan Nel Toth\n\n1 Sol Ring")).toEqual(["commander: Meren of Clan Nel Toth", "main: Sol Ring"]);
  });

  it("reads a count written after the name", () => {
    expect(parseDeckList("Rampant Growth x1\nForest X12\n2 Sol Ring\nMox x")).toEqual([
      { qty: 1, name: "Rampant Growth", board: "main" },
      { qty: 12, name: "Forest", board: "main" },
      { qty: 2, name: "Sol Ring", board: "main" },
      { qty: 1, name: "Mox x", board: "main" },
    ]);
  });

  it("counts an x2 only straight after the name, before any set code or mark", () => {
    expect(parseDeckList("Forest x12\nForest x2 (FDN) 280 *F*\nSol Ring (C21) x2\nIsland *F* x2\nOpt x3 #draw\n2 Negate x4")).toEqual([
      { qty: 12, name: "Forest", board: "main" },
      { qty: 2, name: "Forest", board: "main" },
      // After a set code or a foil mark it is no count: one copy.
      { qty: 1, name: "Sol Ring", board: "main" },
      { qty: 1, name: "Island", board: "main" },
      { qty: 3, name: "Opt", board: "main" },
      // A line that leads with its count keeps its whole name.
      { qty: 2, name: "Negate x4", board: "main" },
    ]);
  });

  /** The lines that differ between two texts, as [before, after] pairs by position. */
  const changed = (before: string, after: string) => {
    const a = before.split("\n");
    const b = after.split("\n");
    return a.length === b.length ? a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]]])) : "another number of lines";
  };

  it("changes a count where it was read, so an edit is never one the list doesn't show", () => {
    const list = "Forest x2 (FDN) 280 *F*\nSol Ring (C21) x2\nIsland *F* x2\n  Opt x3  ";
    for (const [name, was, line] of [
      ["Forest", 2, "Forest x3 (FDN) 280 *F*"],
      // The x2 after the set code or the mark was never the count: the line gets one, and keeps the rest.
      ["Sol Ring", 1, "2 Sol Ring (C21) x2"],
      ["Island", 1, "2 Island *F* x2"],
      ["Opt", 3, "  Opt x4  "],
    ] as const) {
      expect(countInList(list, name)).toBe(was);
      const more = addToList(list, name);
      expect(changed(list, more)).toEqual([[list.split("\n").find((l) => l.includes(name)), line]]);
      expect(countInList(more, name)).toBe(was + 1);
      expect(countInList(removeFromList(more, name), name)).toBe(was);
    }
    expect(removeFromList(list, "Forest")).toContain("Forest x1 (FDN) 280 *F*");
    // The last copy takes its line with it.
    expect(removeFromList(list, "Sol Ring")).toBe("Forest x2 (FDN) 280 *F*\nIsland *F* x2\n  Opt x3  ");
  });

  it("lets a list that names its main deck say where the commanders end", () => {
    const boards = (text: string) => parseDeckList(text).map((l) => `${l.board}: ${l.name}`);
    // Two partners with a blank line between them, then the deck under its heading: both lead.
    const partners = "Commander\n1 Thrasios, Triton Hero\n\n1 Tymna the Weaver\n\nDeck\n1 Sol Ring";
    expect(boards(partners)).toEqual(["commander: Thrasios, Triton Hero", "commander: Tymna the Weaver", "main: Sol Ring"]);
    for (const heading of ["Main", "Mainboard:", "// Maindeck", "Deck (98)"]) {
      expect(boards(partners.replace("Deck", heading))).toEqual(["commander: Thrasios, Triton Hero", "commander: Tymna the Weaver", "main: Sol Ring"]);
    }
    // No such heading further down: the blank line is all that ends the section. A group of
    // the deck (Lands) or a sideboard doesn't name where the deck starts.
    expect(boards("Commander\n1 Meren of Clan Nel Toth\n\n1 Sol Ring\n\nLands\n1 Forest\n\nSideboard\n1 Negate")).toEqual(["commander: Meren of Clan Nel Toth", "main: Sol Ring", "main: Forest", "side: Negate"]);
    // A Deck heading above the commander says nothing about what follows it.
    expect(boards("Deck\n1 Sol Ring\n\nCommander\n1 Meren of Clan Nel Toth\n\n1 Forest")).toEqual(["main: Sol Ring", "commander: Meren of Clan Nel Toth", "main: Forest"]);

    // The search's edits change one line of such a list, on the board they mean.
    expect(addToList(partners, "Forest")).toBe(`${partners}\n1 Forest`);
    expect(addToList(partners, "Sol Ring")).toBe(partners.replace("1 Sol Ring", "2 Sol Ring"));
    expect(addToList(partners, "Kraum, Ludevic's Opus", "commander")).toBe(partners.replace("1 Tymna the Weaver", "1 Tymna the Weaver\n1 Kraum, Ludevic's Opus"));
    expect(removeFromList(partners, "Tymna the Weaver")).toBe("Commander\n1 Thrasios, Triton Hero\n\n\nDeck\n1 Sol Ring");
    expect(countInList(partners, "Tymna the Weaver", "commander")).toBe(1);
  });

  it("edits such a list where the cards are", () => {
    const list = "Commander\n1 Meren of Clan Nel Toth\n\n1 Sol Ring\nForest x2";
    expect(addToList(list, "Forest")).toBe("Commander\n1 Meren of Clan Nel Toth\n\n1 Sol Ring\nForest x3");
    expect(removeFromList(list, "Forest")).toBe("Commander\n1 Meren of Clan Nel Toth\n\n1 Sol Ring\nForest x1");
    expect(addToList(list, "Llanowar Elves")).toBe(`${list}\n1 Llanowar Elves`);
    // Only a commander so far, the list ending on a blank line: the deck's first card gets its heading.
    expect(addToList("Commander\n1 Meren of Clan Nel Toth\n", "Sol Ring")).toBe("Commander\n1 Meren of Clan Nel Toth\n\nDeck\n1 Sol Ring\n");
    expect(parseDeckList(addToList("Commander\n1 Meren of Clan Nel Toth\n", "Sol Ring")).map((l) => l.board)).toEqual(["commander", "main"]);
  });
});

