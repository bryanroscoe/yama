import { describe, expect, it } from "vitest";
import { diffDecks, EXPORT_FORMATS, exportDeck, exportFileName, exportMime, type DiffCard, type ExportCard } from "./deckExport";
import { parseDeckList } from "./decklist";

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

  it("Archidekt: 1x lines with lower-case set codes, the board as a category, no headings", () => {
    expect(exportDeck(cards, "archidekt")).toBe(
      [
        "1x Éowyn, Shieldmaiden (ltc) 2 [Commander{top}]",
        "1x Agadeem's Awakening // Agadeem, the Undercrypt (znr) 90 *E*",
        "1x Fire // Ice",
        "10x Plains (ltr) 263",
        "1x Sol Ring (cmm) 410 *F*",
        "1x Lightning Bolt (m10) 146 [Sideboard{noDeck}{noPrice}]",
        "",
      ].join("\n"),
    );
  });

  it("Magic Online .dek: the main deck, then the commander in the sideboard, by front face; the deck's sideboard left out", () => {
    const text = exportDeck(cards, "mtgo");
    expect(text.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<Deck ')).toBe(true);
    expect(text.endsWith("</Deck>\n")).toBe(true);
    const rows = [...text.matchAll(/<Cards CatID="0" Quantity="(\d+)" Sideboard="(true|false)" Name="([^"]*)" Annotation="0" \/>/g)].map((m) => `${m[1]} ${m[3]} ${m[2]}`);
    expect(rows).toEqual([
      "1 Agadeem's Awakening false",
      "1 Fire // Ice false",
      "10 Plains false",
      "1 Sol Ring false",
      "1 Éowyn, Shieldmaiden true",
    ]);
    expect(text).not.toContain("Lightning Bolt");
  });

  it("Cockatrice .cod: the deck's name, the main zone, and the commander in the side zone", () => {
    expect(exportDeck(cards, "cockatrice", "Riders of Rohan")).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<cockatrice_deck version="1">',
        "    <deckname>Riders of Rohan</deckname>",
        "    <comments></comments>",
        '    <zone name="main">',
        '        <card number="1" name="Agadeem\'s Awakening"/>',
        '        <card number="1" name="Fire // Ice"/>',
        '        <card number="10" name="Plains"/>',
        '        <card number="1" name="Sol Ring"/>',
        "    </zone>",
        '    <zone name="side">',
        '        <card number="1" name="Éowyn, Shieldmaiden"/>',
        "    </zone>",
        "</cockatrice_deck>",
        "",
      ].join("\n"),
    );
  });

  it("escapes names and a deck's name in the XML files", () => {
    const odd: ExportCard[] = [{ name: 'Ach! Hans, Run! <"&">', qty: 1, board: "main" }];
    expect(exportDeck(odd, "mtgo")).toContain('Name="Ach! Hans, Run! &lt;&quot;&amp;&quot;&gt;"');
    const cod = exportDeck(odd, "cockatrice", "Tom & Jerry <3");
    expect(cod).toContain("<deckname>Tom &amp; Jerry &lt;3</deckname>");
    expect(cod).toContain('name="Ach! Hans, Run! &lt;&quot;&amp;&quot;&gt;"');
  });

  it("CSV: a header, then a row a card with its board and printing; names with commas quoted", () => {
    expect(exportDeck(cards, "csv")).toBe(
      [
        "Quantity,Name,Board,Set code,Collector number,Finish",
        '1,"Éowyn, Shieldmaiden",Commander,LTC,2,nonfoil',
        `1,"Agadeem's Awakening // Agadeem, the Undercrypt",Main,ZNR,90,etched`,
        "1,Fire // Ice,Main,,,",
        "10,Plains,Main,LTR,263,nonfoil",
        "1,Sol Ring,Main,CMM,410,foil",
        "1,Lightning Bolt,Sideboard,M10,146,",
        "",
      ].join("\n"),
    );
    expect(exportDeck([{ name: 'Say "Cheese"', qty: 2, board: "main" }], "csv")).toContain('2,"Say ""Cheese""",Main,,,\n');
  });

  it("leaves out cards with no copies, in every format", () => {
    const none: ExportCard[] = [{ name: "Sol Ring", qty: 0, board: "main" }, { name: "Plains", qty: 1, board: "main" }];
    for (const f of EXPORT_FORMATS) expect(exportDeck(none, f.value, "Deck")).not.toContain("Sol Ring");
  });

  it("the text formats read back as the same list", () => {
    const want = (boards: string[]) => cards.filter((c) => boards.includes(c.board)).map((c) => `${c.qty} ${c.name} ${c.board}`).sort();
    const read = (format: "names" | "moxfield") => parseDeckList(exportDeck(cards, format)).map((l) => `${l.qty} ${l.name} ${l.board}`).sort();
    expect(read("moxfield")).toEqual(want(["commander", "main", "side"]));
    expect(read("names")).toEqual(want(["commander", "main"]));
  });

  it("file names", () => {
    expect(exportFileName("Riders of Rohan Upgraded 100", "moxfield")).toBe("riders-of-rohan-upgraded-100-moxfield.txt");
    expect(exportFileName("Éowyn!", "names")).toBe("eowyn-names.txt");
    expect(exportFileName("???", "arena")).toBe("deck-arena.txt");
    expect(exportFileName("Riders of Rohan", "archidekt")).toBe("riders-of-rohan-archidekt.txt");
    expect(exportFileName("Riders of Rohan", "mtgo")).toBe("riders-of-rohan.dek");
    expect(exportFileName("Riders of Rohan", "cockatrice")).toBe("riders-of-rohan.cod");
    expect(exportFileName("???", "csv")).toBe("deck.csv");
  });

  it("media types", () => {
    expect(exportMime("moxfield")).toBe("text/plain;charset=utf-8");
    expect(exportMime("csv")).toBe("text/csv;charset=utf-8");
    expect(exportMime("mtgo")).toBe("application/xml;charset=utf-8");
    expect(exportMime("cockatrice")).toBe("application/xml;charset=utf-8");
  });

  it("offers each format once, with a label and a hint", () => {
    expect(EXPORT_FORMATS.map((f) => f.value)).toEqual(["names", "moxfield", "arena", "archidekt", "mtgo", "cockatrice", "csv"]);
    expect(EXPORT_FORMATS.every((f) => f.label && f.hint.endsWith("."))).toBe(true);
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
