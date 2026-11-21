import { describe, expect, it } from "vitest";
import { applyFixes, checks, commanderChoices, commanders, diff, draftFrom, dropUnknown, fixKey, fixUnknown, namedCommanders, noFixes, pickStands, printLine, setCommanders, sharedText, toSave, type ImportCard, type ImportCardInfo, type PreviewDeck } from "./importLogic";

const info = (oracle_id: string, name: string, color_identity = "", extra: Partial<ImportCardInfo> = {}): ImportCardInfo => ({
  oracle_id,
  name,
  type_line: "Artifact",
  mana_cost: null,
  cmc: 1,
  color_identity,
  image_small: null,
  image_normal: null,
  artist: null,
  can_be_commander: false,
  any_number: false,
  partner: false,
  ...extra,
});

const card = (i: ImportCardInfo, qty = 1, board: ImportCard["board"] = "main", extra: Partial<ImportCard> = {}): ImportCard => ({
  ...i,
  qty,
  board,
  maybe: false,
  set_code: null,
  collector_number: null,
  finish: null,
  print_found: null,
  print_image: null,
  written_as: null,
  ...extra,
});

const atraxa = info("o-atraxa", "Atraxa, Praetors' Voice", "WUBG", { can_be_commander: true, type_line: "Legendary Creature" });
const krenko = info("o-krenko", "Krenko, Mob Boss", "R", { can_be_commander: true, type_line: "Legendary Creature" });
const sol = info("o-sol", "Sol Ring");
const island = info("o-island", "Island", "U", { any_number: true });
const bolt = info("o-bolt", "Lightning Bolt", "R");

function deck(cards: ImportCard[], extra: Partial<PreviewDeck> = {}): PreviewDeck {
  return { name: "Test", cards, unknown: [], commander_marked: false, commander_guessed: false, ...extra };
}

describe("import checks", () => {
  it("counts the deck with its commander and flags what's off", () => {
    const d = draftFrom(deck([card(atraxa, 1, "commander"), card(sol), card(island, 97), card(bolt), card(sol, 1, "side")]));
    const c = checks(d);
    expect(c.total).toBe(100);
    expect(c.sideboard).toBe(1);
    expect(c.identity).toBe("WUBG");
    expect(c.offIdentity.map((x) => x.name)).toEqual(["Lightning Bolt"]);
    expect(c.problems.some((p) => p.includes("outside the commander's colors"))).toBe(true);
    expect(c.ready).toBe(true);
  });

  it("asks for a commander, a name and fixes, and counts copies", () => {
    const d = { ...draftFrom(deck([card(sol, 2), card(island, 30)]), ""), name: "" };
    const c = checks(d);
    expect(c.problems).toContain("Choose the commander.");
    expect(c.problems).toContain("Give the deck a name.");
    expect(c.duplicates.map((x) => x.name)).toEqual(["Sol Ring"]);
    expect(c.problems.some((p) => p.includes("68 short of 100"))).toBe(true);
    expect(c.ready).toBe(false);
  });
});

describe("fixing the list", () => {
  const preview = deck([card(atraxa, 1, "main"), card(sol)], {
    unknown: [{ name: "Sol Rnig", qty: 1, board: "main", maybe: false, set_code: "c21", collector_number: "263", finish: null, suggestions: [sol] }],
  });

  it("a suggestion merges into the card it names", () => {
    const d = fixUnknown(draftFrom(preview), 0, sol);
    expect(d.unknown).toHaveLength(0);
    expect(d.cards.find((c) => c.oracle_id === "o-sol")?.qty).toBe(2);
  });

  it("an unknown line can be left out", () => {
    expect(dropUnknown(draftFrom(preview), 0).unknown).toHaveLength(0);
  });

  it("choosing commanders moves the old one back to the deck", () => {
    let d = draftFrom(deck([card(atraxa, 1, "commander"), card(krenko), card(sol)]));
    expect(commanderChoices(d).map((c) => c.name)).toEqual(["Atraxa, Praetors' Voice", "Krenko, Mob Boss"]);
    d = setCommanders(d, ["o-krenko"]);
    expect(d.cards.find((c) => c.oracle_id === "o-atraxa")?.board).toBe("main");
    expect(d.cards.find((c) => c.oracle_id === "o-krenko")?.board).toBe("commander");
    expect(d.commanderGuessed).toBe(false);
  });
});

describe("saving", () => {
  it("merges cards and keeps printings that exist", () => {
    const d = draftFrom(
      deck([
        card(atraxa, 1, "commander", { set_code: "2x2", collector_number: "190", print_found: true }),
        card(sol, 1, "main", { set_code: "c21", collector_number: "263", finish: "foil", print_found: true }),
        card(sol, 1, "main", { set_code: "cmm", collector_number: "410", print_found: true }),
        card(bolt, 1, "main", { set_code: "zzz", collector_number: "1", print_found: false }),
      ]),
    );
    const s = toSave(d);
    expect(s.cards.find((c) => c.oracle_id === "o-sol")?.qty).toBe(2);
    expect(s.prints).toEqual([
      { oracle_id: "o-atraxa", set_code: "2x2", collector_number: "190", finish: "nonfoil", proxy: false },
      { oracle_id: "o-sol", set_code: "c21", collector_number: "263", finish: "foil", proxy: false },
    ]);
  });

  it("keeps a proxy mark, with or without a printing", () => {
    const d = draftFrom(
      deck([
        card(sol, 1, "main", { set_code: "c21", collector_number: "263", print_found: true, proxy: true }),
        card(bolt, 1, "main", { proxy: true }),
        card(island, 10, "main"),
      ]),
    );
    expect(toSave(d).prints).toEqual([
      { oracle_id: "o-sol", set_code: "c21", collector_number: "263", finish: "nonfoil", proxy: true },
      { oracle_id: "o-bolt", set_code: "", collector_number: null, finish: "nonfoil", proxy: true },
    ]);
    expect(printLine({ set_code: "c21", collector_number: "263", finish: "foil", proxy: true })).toBe("C21 263, foil, proxy");
  });

  it("a new version shows what goes in and out", () => {
    const now = [
      { oracle_id: "o-sol", name: "Sol Ring", qty: 1, board: "main" as const },
      { oracle_id: "o-island", name: "Island", qty: 10, board: "main" as const },
    ];
    const next = [
      { oracle_id: "o-island", name: "Island", qty: 8, board: "main" as const },
      { oracle_id: "o-bolt", name: "Lightning Bolt", qty: 1, board: "main" as const },
    ];
    expect(diff(now, next)).toEqual({
      added: [{ name: "Lightning Bolt", qty: 1, board: "main" }],
      removed: [
        { name: "Island", qty: 2, board: "main" },
        { name: "Sol Ring", qty: 1, board: "main" },
      ],
    });
  });
});

describe("names", () => {
  it("a deck with no name is named after its commander", () => {
    expect(draftFrom(deck([card(atraxa, 1, "commander")], { name: null })).name).toBe("Atraxa");
    expect(draftFrom(deck([card(atraxa, 1, "commander")], { name: null }), "From file").name).toBe("From file");
    expect(draftFrom(deck([card(atraxa, 1, "commander")], { name: "Given" }), "From file").name).toBe("Given");
  });
});

describe("helpers", () => {
  it("a share brings its text and link", () => {
    expect(sharedText(new URLSearchParams("title=Deck&text=Atraxa&url=https%3A%2F%2Fmoxfield.com%2Fdecks%2Fx"))).toBe("Atraxa\nhttps://moxfield.com/decks/x");
    expect(sharedText(new URLSearchParams("text=https%3A%2F%2Fmoxfield.com%2Fdecks%2Fx&url=https%3A%2F%2Fmoxfield.com%2Fdecks%2Fx"))).toBe("https://moxfield.com/decks/x");
  });
  it("names a printing briefly", () => {
    expect(printLine({ set_code: "c21", collector_number: "263", finish: "foil" })).toBe("C21 263, foil");
    expect(printLine({ set_code: null, collector_number: null, finish: null })).toBe("");
  });
});

describe("fixes kept while the list is read again", () => {
  const unknown = (name: string, board: ImportCard["board"] = "main") => ({ name, qty: 1, board, maybe: false, set_code: null, collector_number: null, finish: null, suggestions: [] });
  const read = () => draftFrom(deck([card(sol), card(krenko)], { name: null, commander_marked: true, unknown: [unknown("Atraxa, Praetor's Voice", "commander"), unknown("Zzz Qqq"), unknown("Lightnig Bolt")] }));

  it("makes each fix again on a new reading, by the name as written", () => {
    const fixes = noFixes();
    fixes.lines.set(fixKey("Atraxa, Praetor's Voice"), atraxa);
    fixes.lines.set(fixKey(" zzz qqq "), null);
    const d = applyFixes(read(), fixes);
    expect(d.unknown.map((u) => u.name)).toEqual(["Lightnig Bolt"]);
    expect(d.cards.find((c) => c.oracle_id === "o-atraxa")).toMatchObject({ board: "commander", written_as: "Atraxa, Praetor's Voice" });
    // The deck had no name: it takes its commander's, as if the line had matched.
    expect(d.name).toBe("Atraxa");
    // Nothing fixed: the reading is as the server gave it.
    expect(applyFixes(read(), noFixes())).toEqual(read());
  });

  it("picks the commanders again when they are still in the list, and keeps a typed name", () => {
    // Picked while the list's own commander line matched no card: it named none that could lead.
    const fixes = { ...noFixes(), commanders: ["o-krenko"], pickedOver: [], name: "Goblins" };
    const d = applyFixes(read(), fixes);
    expect(d.cards.find((c) => c.oracle_id === "o-krenko")!.board).toBe("commander");
    expect(d.name).toBe("Goblins");
    // A pick that names a card no longer in the list is let go.
    const gone = applyFixes(read(), { ...noFixes(), commanders: ["o-atraxa"], pickedOver: [] });
    expect(gone.cards.every((c) => c.board !== "commander")).toBe(true);
  });

  it("keeps a commander picked over the list's own while the list still names that one", () => {
    // "Commander / 1 Atraxa" with Krenko in the deck; the person picked Krenko instead.
    const list = () => draftFrom(deck([card(atraxa, 1, "commander"), card(krenko), card(sol)], { commander_marked: true }));
    const fixes = { ...noFixes(), commanders: ["o-krenko"], pickedOver: namedCommanders(list(), noFixes()) };
    expect(fixes.pickedOver).toEqual(["o-atraxa"]);
    expect(pickStands(list(), fixes)).toBe(true);
    expect(commanders(applyFixes(list(), fixes)).map((c) => c.name)).toEqual(["Krenko, Mob Boss"]);
    // The person then writes the pick under the heading themselves: nothing to undo.
    const written = draftFrom(deck([card(krenko, 1, "commander"), card(atraxa), card(sol)], { commander_marked: true }));
    expect(pickStands(written, fixes)).toBe(true);
  });

  it("lets a picked commander go once the person writes a different one under the heading", () => {
    const thrasios = info("o-thrasios", "Thrasios, Triton Hero", "GU", { can_be_commander: true, type_line: "Legendary Creature" });
    // Picked Krenko over the list's Atraxa; then typed Thrasios under Commander, both others in the deck.
    const fixes = { ...noFixes(), commanders: ["o-krenko"], pickedOver: ["o-atraxa"] };
    const retyped = draftFrom(deck([card(thrasios, 1, "commander"), card(atraxa), card(krenko)], { commander_marked: true }));
    expect(pickStands(retyped, fixes)).toBe(false);
    expect(commanders(applyFixes(retyped, fixes)).map((c) => c.name)).toEqual(["Thrasios, Triton Hero"]);
    // Picked when the list named no commander (Yama guessed): a heading added since is the answer.
    const guessed = { ...noFixes(), commanders: ["o-krenko"] };
    expect(pickStands(draftFrom(deck([card(atraxa, 1, "commander"), card(krenko)], { commander_guessed: true })), guessed)).toBe(true);
    expect(pickStands(draftFrom(deck([card(atraxa, 1, "commander"), card(krenko)], { commander_marked: true })), guessed)).toBe(false);
  });

  it("counts a fixed commander line as one the list names", () => {
    const fixes = noFixes();
    expect(namedCommanders(read(), fixes)).toEqual([]);
    fixes.lines.set(fixKey("Atraxa, Praetor's Voice"), atraxa);
    expect(namedCommanders(read(), fixes)).toEqual(["o-atraxa"]);
    // A list with no heading names none.
    expect(namedCommanders(draftFrom(deck([card(atraxa, 1, "commander")], { commander_guessed: true })), fixes)).toBeNull();
  });

  it("a fixed commander or a picked one names a deck that has no name, and leaves a name alone", () => {
    const named = { ...read(), name: "Mine" };
    expect(fixUnknown(named, 0, atraxa).name).toBe("Mine");
    expect(fixUnknown(read(), 0, atraxa).name).toBe("Atraxa");
    expect(fixUnknown(read(), 2, bolt).name).toBe("");
    expect(setCommanders(read(), ["o-krenko"]).name).toBe("Krenko");
    expect(setCommanders(named, ["o-krenko"]).name).toBe("Mine");
  });
});

describe("two partners at the top of a list with no heading", () => {
  const thrasios = info("o-thrasios", "Thrasios, Triton Hero", "UG", { can_be_commander: true, partner: true, type_line: "Legendary Creature" });
  const tymna = info("o-tymna", "Tymna the Weaver", "WB", { can_be_commander: true, partner: true, type_line: "Legendary Creature" });
  const leaders = (d: PreviewDeck) => draftFrom(d).cards.filter((c) => c.board === "commander").map((c) => c.name);

  it("both lead, as a guess, and name the deck", () => {
    const d = deck([card(thrasios, 1, "commander"), card(tymna), card(sol)], { name: null, commander_guessed: true });
    expect(leaders(d)).toEqual(["Thrasios, Triton Hero", "Tymna the Weaver"]);
    expect(draftFrom(d).name).toBe("Thrasios and Tymna the Weaver");
    expect(draftFrom(d).commanderGuessed).toBe(true);
  });

  it("only when the second card has Partner too, sits next, and the list didn't name its commander", () => {
    expect(leaders(deck([card(thrasios, 1, "commander"), card(atraxa), card(sol)], { commander_guessed: true }))).toEqual(["Thrasios, Triton Hero"]);
    expect(leaders(deck([card(thrasios, 1, "commander"), card(sol), card(tymna)], { commander_guessed: true }))).toEqual(["Thrasios, Triton Hero"]);
    expect(leaders(deck([card(atraxa, 1, "commander"), card(tymna), card(sol)], { commander_guessed: true }))).toEqual(["Atraxa, Praetors' Voice"]);
    expect(leaders(deck([card(thrasios, 1, "commander"), card(tymna), card(sol)], { commander_marked: true }))).toEqual(["Thrasios, Triton Hero"]);
    expect(leaders(deck([card(thrasios, 1, "commander"), card(tymna, 1, "side"), card(sol)], { commander_guessed: true }))).toEqual(["Thrasios, Triton Hero"]);
  });
});

describe("counts in words", () => {
  it("says 1 card, not 1 cards", () => {
    const one = checks(draftFrom(deck([card(sol)])));
    expect(one.problems).toContain("1 card with the commander: 99 short of 100.");
    const two = checks(draftFrom(deck([card(sol), card(bolt)])));
    expect(two.problems).toContain("2 cards with the commander: 98 short of 100.");
  });
});
