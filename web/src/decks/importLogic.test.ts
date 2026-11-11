import { describe, expect, it } from "vitest";
import { checks, commanderChoices, diff, draftFrom, dropUnknown, fixUnknown, printLine, setCommanders, sharedText, toSave, type ImportCard, type ImportCardInfo, type PreviewDeck } from "./importLogic";

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
