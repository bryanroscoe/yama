import { addToList, listText, removeFromList } from "@yama/core";
import { describe, expect, it } from "vitest";
import type { Draft, ImportCard, UnknownLine } from "./importLogic";
import { sameReading, tidyText } from "./listReading";

const card = (name: string, over: Partial<ImportCard> = {}): ImportCard =>
  ({ oracle_id: name, name, qty: 1, board: "main", maybe: false, set_code: null, collector_number: null, finish: null, print_found: null, written_as: null, ...over }) as ImportCard;
const unknown = (name: string, over: Partial<UnknownLine> = {}): UnknownLine => ({ name, qty: 1, board: "main", maybe: false, set_code: null, collector_number: null, finish: null, suggestions: [], ...over });
const read = (cards: ImportCard[], unknownLines: UnknownLine[] = []): Pick<Draft, "cards" | "unknown"> => ({ cards, unknown: unknownLines });

// What the server's preview reads from each text below (server/src/deck_import/formats.rs).
const ATRAXA = card("Atraxa, Praetors' Voice", { board: "commander" });

describe("whether the card search may edit a list line by line", () => {
  it("agrees on Yama's own format, with printings, bare names, front faces and other spellings", () => {
    const text = "Commander\n1 Atraxa, Praetors' Voice (CM2) 10\n\nDeck\n1 Sol Ring (CMM) 410 *F*\n2x Forest\nfable of the mirror-breaker\n1 Lim-Dul's Vault\n\nSideboard\n1 Negate";
    const server = read([
      ATRAXA,
      card("Sol Ring", { set_code: "cmm", collector_number: "410", finish: "foil" }),
      card("Forest", { qty: 2 }),
      card("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"),
      card("Lim-Dûl's Vault", { written_as: "Lim-Dul's Vault" }),
      card("Negate", { board: "side" }),
    ]);
    expect(sameReading(text, server)).toBe(true);
    // And stays in agreement after the search's own edits.
    expect(sameReading(addToList(text, "Forest"), read([...server.cards.filter((c) => c.name !== "Forest"), card("Forest", { qty: 3 })]))).toBe(true);
    expect(sameReading(removeFromList(text, "Negate"), read(server.cards.filter((c) => c.name !== "Negate")))).toBe(true);
  });

  it("agrees when a card is listed on two lines with different printings", () => {
    const text = "Deck\n1 Island (ELD) 254\n3 Island (M21) 264";
    expect(sameReading(text, read([card("Island", { set_code: "eld", collector_number: "254" }), card("Island", { qty: 3, set_code: "m21", collector_number: "264" })]))).toBe(true);
  });

  it("agrees about a line that matched no card", () => {
    expect(sameReading("Deck\n1 Sol Ring\n2 Not A Real Card", read([card("Sol Ring")], [unknown("Not A Real Card", { qty: 2 })]))).toBe(true);
    expect(sameReading("", read([]))).toBe(true);
  });

  it("agrees about a Considering section, which the preview reads as maybeboard cards", () => {
    const text = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n\nConsidering\n2 Opt";
    expect(sameReading(text, read([ATRAXA, card("Sol Ring"), card("Opt", { qty: 2, board: "side", maybe: true })]))).toBe(true);
    // The same card under Sideboard is another list.
    expect(sameReading(text, read([ATRAXA, card("Sol Ring"), card("Opt", { qty: 2, board: "side" })]))).toBe(false);
  });

  it("disagrees on a Magic Online list, where the commander follows a blank line", () => {
    const text = "1 Sol Ring\n98 Forest\n\n1 Atraxa, Praetors' Voice";
    expect(sameReading(text, read([card("Sol Ring"), card("Forest", { qty: 98 }), ATRAXA]))).toBe(false);
  });

  it("disagrees on headings only the preview knows", () => {
    expect(sameReading("Deck\n1 Sol Ring\n\nCompanion\n1 Lurrus of the Dream-Den", read([card("Sol Ring"), card("Lurrus of the Dream-Den", { board: "side" })]))).toBe(false);
    expect(sameReading("Deck\n1 Sol Ring\n[Sideboard]\n1 Negate", read([card("Sol Ring"), card("Negate", { board: "side" })]))).toBe(false);
  });

  it("disagrees on other sites' line formats and tags", () => {
    expect(sameReading("1 [C21#263] Sol Ring", read([card("Sol Ring", { set_code: "c21", collector_number: "263" })]))).toBe(false);
    expect(sameReading("x1 Sol Ring", read([card("Sol Ring")]))).toBe(false);
    expect(sameReading("1\tSol Ring", read([card("Sol Ring")]))).toBe(false);
    expect(sameReading("1x Lightning Greaves (cmm) 393 [Maybeboard{noDeck}{noPrice}]", read([card("Lightning Greaves", { board: "side", maybe: true })]))).toBe(false);
    expect(sameReading("1x Atraxa, Praetors' Voice (cm2) 10 [Commander{top}]\n1x Sol Ring", read([ATRAXA, card("Sol Ring")]))).toBe(false);
    expect(sameReading("1 Atraxa, Praetors' Voice *CMDR*\n1 Sol Ring", read([ATRAXA, card("Sol Ring")]))).toBe(false);
  });

  it("disagrees on a file that isn't a text list at all", () => {
    expect(sameReading("Quantity,Name\n1,Sol Ring", read([card("Sol Ring")]))).toBe(false);
    expect(sameReading('[{"name":"Sol Ring","quantity":1}]', read([card("Sol Ring")]))).toBe(false);
  });

  it("disagrees when a list with no headings has its first card read as the commander", () => {
    expect(sameReading("1 Atraxa, Praetors' Voice\n1 Sol Ring", read([ATRAXA, card("Sol Ring")]))).toBe(false);
  });

  it("disagrees when the counts differ", () => {
    expect(sameReading("Deck\n1 Sol Ring", read([card("Sol Ring", { qty: 2 })]))).toBe(false);
    expect(sameReading("Deck\n1 Sol Ring", read([card("Sol Ring"), card("Forest")]))).toBe(false);
  });
});

describe("rewriting a list in Yama's format", () => {
  const server = read(
    [
      ATRAXA,
      card("Sol Ring", { set_code: "c21", collector_number: "263", finish: "foil", print_found: true }),
      card("Forest", { qty: 30, set_code: "eld", collector_number: null }),
      card("Arcane Signet", { set_code: "xyz", collector_number: "1", print_found: false }),
      card("Negate", { board: "side", finish: "etched", set_code: "m20", collector_number: "69" }),
    ],
    [unknown("Not A Real Card", { qty: 2 })],
  );

  it("writes every card under its board with the printing the source named, and keeps lines that matched nothing", () => {
    expect(tidyText(server)).toBe(
      ["Commander", "1 Atraxa, Praetors' Voice", "", "Deck", "1 Sol Ring (C21) 263 *F*", "30 Forest (ELD)", "1 Arcane Signet", "2 Not A Real Card", "", "Sideboard", "1 Negate (M20) 69 *E*"].join("\n"),
    );
  });

  it("writes a maybeboard under Considering", () => {
    const withMaybe = read([ATRAXA, card("Sol Ring"), card("Opt", { board: "side", maybe: true })], [unknown("Mystery", { board: "side", maybe: true })]);
    expect(tidyText(withMaybe)).toBe("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n\nConsidering\n1 Opt\n1 Mystery");
    expect(sameReading(tidyText(withMaybe), withMaybe)).toBe(true);
  });

  it("gives a text both readers read the same way", () => {
    expect(sameReading(tidyText(server), server)).toBe(true);
    const plain = read([ATRAXA, card("Sol Ring")]);
    expect(tidyText(plain)).toBe(listText([{ qty: 1, name: "Atraxa, Praetors' Voice", board: "commander" }, { qty: 1, name: "Sol Ring", board: "main" }]));
  });
});
