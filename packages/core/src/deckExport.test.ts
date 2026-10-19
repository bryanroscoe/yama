import { describe, expect, it } from "vitest";
import { diffDecks, exportDeck, exportFileName, type DiffCard, type ExportCard } from "./deckExport";

const cards: ExportCard[] = [
  { name: "Sol Ring", qty: 1, board: "main", setCode: "cmm", collectorNumber: "410", finish: "foil", layout: "normal" },
  { name: "Éowyn, Shieldmaiden", qty: 1, board: "commander", setCode: "ltc", collectorNumber: "2", finish: "nonfoil", layout: "normal" },
  { name: "Plains", qty: 10, board: "main", setCode: "ltr", collectorNumber: "263", finish: "nonfoil", layout: "normal" },
  { name: "Agadeem's Awakening // Agadeem, the Undercrypt", qty: 1, board: "main", setCode: "znr", collectorNumber: "90", finish: "etched", layout: "modal_dfc" },
  { name: "Fire // Ice", qty: 1, board: "main", setCode: null, collectorNumber: null, layout: "split" },
  { name: "Lightning Bolt", qty: 1, board: "side", setCode: "m10", collectorNumber: "146", layout: "normal" },
];

describe("exports", () => {
  it("names only: Commander and Deck headings, no sideboard, sorted", () => {
    expect(exportDeck(cards, "names")).toBe(
      [
        "Commander",
        "1 Éowyn, Shieldmaiden",
        "",
        "Deck",
        "1 Agadeem's Awakening // Agadeem, the Undercrypt",
        "1 Fire // Ice",
        "10 Plains",
        "1 Sol Ring",
        "",
      ].join("\n"),
    );
  });

  it("Moxfield: set and number, finish marks, sideboard; a card without a printing goes by name", () => {
    const text = exportDeck(cards, "moxfield");
    expect(text).toContain("1 Sol Ring (CMM) 410 *F*\n");
    expect(text).toContain("1 Agadeem's Awakening // Agadeem, the Undercrypt (ZNR) 90 *E*\n");
    expect(text).toContain("10 Plains (LTR) 263\n");
    expect(text).toContain("1 Fire // Ice\n");
    expect(text.endsWith("Sideboard\n1 Lightning Bolt (M10) 146\n")).toBe(true);
  });

  it("Arena: front faces for double-faced cards, split cards whole, no set codes", () => {
    const text = exportDeck(cards, "arena");
    expect(text).toContain("1 Agadeem's Awakening\n");
    expect(text).toContain("1 Fire // Ice\n");
    expect(text).not.toContain("(");
    expect(text.startsWith("Commander\n1 Éowyn, Shieldmaiden\n\nDeck\n")).toBe(true);
  });

  it("file names", () => {
    expect(exportFileName("Riders of Rohan Upgraded 100", "moxfield")).toBe("riders-of-rohan-upgraded-100-moxfield.txt");
    expect(exportFileName("Éowyn!", "names")).toBe("eowyn-names.txt");
    expect(exportFileName("???", "arena")).toBe("deck-arena.txt");
  });
});

describe("version diffs", () => {
  const c = (oracle_id: string, qty: number, board: DiffCard["board"] = "main"): DiffCard => ({ oracle_id, name: oracle_id, qty, board });
  it("lists added, removed and changed cards by board", () => {
    const before = [c("Omo", 1, "commander"), c("Cultivate", 1), c("Forest", 30), c("Sol Ring", 1)];
    const after = [c("Omo", 1, "commander"), c("Three Visits", 1), c("Forest", 29), c("Sol Ring", 1), c("Cultivate", 1, "side")];
    const d = diffDecks(before, after);
    expect(d.added).toEqual([
      { name: "Cultivate", board: "side", before: 0, after: 1 },
      { name: "Three Visits", board: "main", before: 0, after: 1 },
    ]);
    expect(d.removed).toEqual([{ name: "Cultivate", board: "main", before: 1, after: 0 }]);
    expect(d.changed).toEqual([{ name: "Forest", board: "main", before: 30, after: 29 }]);
  });

  it("is empty for the same list in another order, and adds up split rows", () => {
    const d = diffDecks([c("A", 1), c("B", 2)], [c("B", 1), c("A", 1), c("B", 1)]);
    expect(d).toEqual({ added: [], removed: [], changed: [] });
  });
});
