import { describe, expect, it } from "vitest";
import { addToList, countInList, listText, parseDeckList, removeFromList } from "./decklist";

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
