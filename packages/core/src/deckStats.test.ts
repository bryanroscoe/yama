import { describe, expect, it } from "vitest";
import { deckStats, pipsOf, type StatCard } from "./deckStats";

const card = (name: string, typeLine: string, cmc: number, manaCost: string | null, producedMana: string | null = "", extra: Partial<StatCard> = {}): StatCard => ({
  name,
  qty: 1,
  board: "main",
  cmc,
  typeLine,
  manaCost,
  producedMana,
  ...extra,
});

describe("pips", () => {
  it("counts colored symbols, hybrid for both colors, front face only", () => {
    expect(pipsOf("{2}{W}{W}")).toEqual({ W: 2, U: 0, B: 0, R: 0, G: 0 });
    expect(pipsOf("{W/U}{G/P}{2/R}{C}{X}")).toEqual({ W: 1, U: 1, B: 0, R: 1, G: 1 });
    expect(pipsOf("{1}{G} // {3}{U}{U}")).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 1 });
    expect(pipsOf(null)).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0 });
  });
});

describe("deck stats", () => {
  const deck: StatCard[] = [
    card("Éowyn, Shieldmaiden", "Legendary Creature — Human Knight", 5, "{2}{R}{W}{U}", "", { board: "commander" }),
    card("Sol Ring", "Artifact", 1, "{1}", "C"),
    card("Swords to Plowshares", "Instant", 1, "{W}"),
    card("Adeline, Resplendent Cathar", "Legendary Creature — Human Knight", 3, "{1}{W}{W}"),
    card("Ugin, the Spirit Dragon", "Legendary Planeswalker — Ugin", 8, "{8}"),
    card("Agadeem's Awakening // Agadeem, the Undercrypt", "Sorcery // Land", 3, "{X}{B}{B}{B}", "B"),
    card("Plains", "Basic Land — Plains", 0, null, "W", { qty: 10 }),
    card("Island", "Basic Land — Island", 0, null, "U", { qty: 2 }),
    card("Hallowed Fountain", "Land — Plains Island", 0, null, "WU"),
    card("Evolving Wilds", "Land", 0, null, "", { oracleText: "{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle." }),
    card("Wooded Foothills", "Land", 0, null, "", { oracleText: "{T}, Pay 1 life, Sacrifice Wooded Foothills: Search your library for a Mountain or Forest card, put it onto the battlefield, then shuffle." }),
    card("Lightning Bolt", "Instant", 1, "{R}", "", { board: "side" }),
    { name: "Mystery Card", qty: 1, board: "main", cmc: null, typeLine: null, manaCost: null, producedMana: null },
  ];
  const s = deckStats(deck);

  it("counts cards, lands and averages without the sideboard", () => {
    expect(s.cards).toBe(22);
    expect(s.lands).toBe(15);
    expect(s.nonlands).toBe(6); // the spell side of a double-faced land counts as a spell
    expect(s.averageMvNonland).toBeCloseTo((5 + 1 + 1 + 3 + 8 + 3) / 6, 2);
    expect(s.averageMv).toBeCloseTo(21 / 21, 2);
    expect(s.unknownCards).toEqual(["Mystery Card"]);
  });

  it("splits the curve into creatures and the rest, with 7+ together", () => {
    expect(s.curve[1]).toEqual({ mv: 1, creatures: 0, others: 2 });
    expect(s.curve[3]).toEqual({ mv: 3, creatures: 1, others: 1 });
    expect(s.curve[5]).toEqual({ mv: 5, creatures: 1, others: 0 });
    expect(s.curve[7]).toEqual({ mv: 7, creatures: 0, others: 1 });
    expect(s.curve.reduce((a, b) => a + b.creatures + b.others, 0)).toBe(6);
  });

  it("compares pips with land sources, fetch lands included", () => {
    const by = Object.fromEntries(s.colors.map((c) => [c.color, c]));
    // W: Éowyn 1 + Swords 1 + Adeline 2 = 4 pips; sources: 10 Plains, Fountain, Wilds (basics here: W, U).
    expect(by.W).toEqual({ color: "W", pips: 4, sources: 12 });
    // U: 1 pip; 2 Islands, Fountain, Wilds.
    expect(by.U).toEqual({ color: "U", pips: 1, sources: 4 });
    // R: no Mountain or Forest target exists in this list, so Foothills provides no access.
    expect(by.R).toEqual({ color: "R", pips: 1, sources: 0 });
    // B: three pips and one potential land face; these are descriptive counts.
    expect(by.B).toEqual({ color: "B", pips: 3, sources: 1 });
    // G: no pips, so not listed.
    expect(by.G).toBeUndefined();
    expect(s.landsWithoutManaData).toEqual([]);
    expect(s.landsWithManaData).toBe(6);
  });

  it("doesn't count sources while any land's mana isn't loaded", () => {
    // A land without data could make any color: missing counts, not zeros.
    const partly = deckStats([...deck, card("Unloaded Land", "Land", 0, null, null)]);
    expect(partly.landsWithoutManaData).toEqual(["Unloaded Land"]);
    expect(partly.colors.find((c) => c.color === "W")).toEqual({ color: "W", pips: 4, sources: null });
    // Before the import that reads produced_mana, no land has data at all.
    const none = deckStats([
      card("Counterspell", "Instant", 2, "{U}{U}"),
      card("Island", "Basic Land — Island", 0, null, null, { qty: 30 }),
    ]);
    expect(none.colors).toEqual([{ color: "U", pips: 2, sources: null }]);
    expect(none.landsWithManaData).toBe(0);
    expect(none.lands).toBe(30);
  });

  it("reports counts without inventing a shortage threshold", () => {
    const thin = deckStats([
      card("Cryptic Command", "Instant", 4, "{1}{U}{U}{U}", "", { qty: 1 }),
      card("Counterspell", "Instant", 2, "{U}{U}", "", { qty: 1 }),
      card("Island", "Basic Land — Island", 0, null, "U"),
    ]);
    expect(thin.colors).toEqual([{ color: "U", pips: 5, sources: 1 }]);
  });

  it("counts only fetchable front-face targets, including the target's other colors", () => {
    const cards = [
      card("White spell", "Instant", 1, "{W}"),
      card("Blue spell", "Instant", 1, "{U}"),
      card("Green spell", "Instant", 1, "{G}"),
      card("Wooded Foothills", "Land", 0, null, "", { oracleText: "Search your library for a Mountain or Forest card." }),
      card("Breeding Pool", "Land — Forest Island", 0, null, "GU"),
      card("Spell // Land", "Sorcery // Land — Plains", 1, "{W}", "W"),
      card("Flooded Strand", "Land", 0, null, "", { oracleText: "Search your library for a Plains or Island card." }),
    ];
    const s = deckStats(cards);
    expect(s.colors).toEqual([
      { color: "W", pips: 2, sources: 1 }, // only the MDFC, not a fetchable Plains
      { color: "U", pips: 1, sources: 3 }, // Pool and both fetches
      { color: "G", pips: 1, sources: 3 },
    ]);
    expect(deckStats(cards)).toEqual(s);
    expect(deckStats([...cards].reverse())).toEqual(s);
  });

  it("handles an empty deck", () => {
    const empty = deckStats([]);
    expect(empty.averageMv).toBeNull();
    expect(empty.averageMvNonland).toBeNull();
    expect(empty.colors).toEqual([]);
  });
});
