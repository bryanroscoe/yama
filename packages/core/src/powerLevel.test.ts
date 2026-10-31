import { describe, expect, it } from "vitest";
import type { StatCard } from "./deckStats";
import { isCheapDraw, isCheapInteraction, isCheapMana, isTutor, powerEstimate, type PowerSignals } from "./powerLevel";

const card = (name: string, typeLine: string, cmc: number, oracleText = "", producedMana = "", extra: Partial<StatCard> = {}): StatCard => ({
  name, qty: 1, board: "main", cmc, typeLine, manaCost: null, producedMana, oracleText, ...extra,
});

const none: PowerSignals = { bracket: 2, gameChangers: [], twoCardCombos: [], massLandDenial: [], extraTurns: [] };

const solRing = card("Sol Ring", "Artifact", 1, "{T}: Add {C}{C}.", "C");
const rampant = card("Rampant Growth", "Sorcery", 2, "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.");
const cultivate = card("Cultivate", "Sorcery", 3, "Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.");
const brainstorm = card("Brainstorm", "Instant", 1, "Draw three cards, then put two cards from your hand on top of your library in any order.");
const swords = card("Swords to Plowshares", "Instant", 1, "Exile target creature. Its controller gains life equal to its power.");
const counterspell = card("Counterspell", "Instant", 2, "Counter target spell.");
const relic = card("Relic of Progenitus", "Artifact", 1, "{T}: Target player exiles a card from their graveyard.\n{1}, Exile Relic of Progenitus: Exile all graveyards. Draw a card.");
const demonic = card("Demonic Tutor", "Sorcery", 2, "Search your library for a card, put that card into your hand, then shuffle.");
const woodElves = card("Wood Elves", "Creature — Elf Scout", 3, "When Wood Elves enters, search your library for a Forest card and put that card onto the battlefield. Then shuffle.");
const forest = card("Forest", "Basic Land — Forest", 0, "({T}: Add {G}.)", "G");
const fetch = card("Wooded Foothills", "Land", 0, "{T}, Pay 1 life, Sacrifice Wooded Foothills: Search your library for a Mountain or Forest card, put it onto the battlefield, then shuffle.");
const big = card("Ulamog, the Ceaseless Hunger", "Legendary Creature — Eldrazi", 10, "When you cast this spell, exile two target permanents.");

describe("power signals from card text", () => {
  it("counts rocks, dorks, rituals and cheap land ramp as cheap mana", () => {
    expect(isCheapMana(solRing)).toBe(true);
    expect(isCheapMana(rampant)).toBe(true);
    expect(isCheapMana(cultivate)).toBe(false);
    expect(isCheapMana(forest)).toBe(false);
  });

  it("counts cheap draw and targeted cheap interaction", () => {
    expect(isCheapDraw(brainstorm)).toBe(true);
    expect(isCheapDraw(relic)).toBe(true);
    expect(isCheapDraw(swords)).toBe(false);
    expect(isCheapInteraction(swords)).toBe(true);
    expect(isCheapInteraction(counterspell)).toBe(true);
    expect(isCheapInteraction(relic)).toBe(false);
    expect(isCheapInteraction(big)).toBe(false);
  });

  it("counts tutors for nonland cards only, never land searches or lands", () => {
    expect(isTutor(demonic)).toBe(true);
    expect(isTutor(woodElves)).toBe(false);
    expect(isTutor(rampant)).toBe(false);
    expect(isTutor(fetch)).toBe(false);
  });
});

describe("power estimate", () => {
  it("gives no score without a bracket suggestion of 2 to 4", () => {
    expect(powerEstimate([solRing], { ...none, bracket: null })).toBeNull();
    expect(powerEstimate([solRing], { ...none, bracket: 1 })).toBeNull();
    expect(powerEstimate([solRing], { ...none, bracket: 5 })).toBeNull();
  });

  it("starts at the bottom of the bracket's band and stays inside it", () => {
    expect(powerEstimate([big], none)!.score).toBe(3);
    expect(powerEstimate([big], { ...none, bracket: 3 })!.score).toBe(5);
    expect(powerEstimate([big], { ...none, bracket: 4 })!.band).toEqual([7, 9]);

    const maxed = Array.from({ length: 8 }, () => [solRing, brainstorm, swords, demonic]).flat();
    const top = powerEstimate(maxed, {
      bracket: 4, gameChangers: ["A", "B", "C", "D", "E"], twoCardCombos: ["X + Y", "Y + Z", "Z + W"],
      massLandDenial: ["Armageddon"], extraTurns: ["Time Warp", "Temporal Manipulation"],
    })!;
    expect(top.score).toBe(9);
    expect(top.factors.reduce((n, f) => n + f.weight, 0)).toBeCloseTo(1);
  });

  it("moves inside the band by capped, weighted factors and names the cards behind them", () => {
    const deck = [solRing, rampant, brainstorm, swords, counterspell, demonic, forest, card("Spare", "Sideboard", 1, "", "C", { board: "side" })];
    const e = powerEstimate(deck, { ...none, bracket: 3, gameChangers: ["Demonic Tutor"], twoCardCombos: ["A + B"] })!;
    const by = Object.fromEntries(e.factors.map((f) => [f.key, f]));
    expect(by.mana!.count).toBe(2);
    expect(by.mana!.cards).toEqual(["Sol Ring", "Rampant Growth"]);
    expect(by.interaction!.count).toBe(2);
    expect(by.tutors!.cards).toEqual(["Demonic Tutor"]);
    // Nonland average 1.33: the curve factor is full.
    expect(by.curve!.points).toBeCloseTo(0.3);
    expect(by.gameChangers!.points).toBeCloseTo(0.075);
    expect(by.combos!.points).toBeCloseTo(0.15);
    // 5 + mana .075 + draw .025 + interaction .075 + tutors .05 + curve .3 + GC .075 + combos .15
    expect(e.score).toBe(5.8);
  });

  it("lists cards missing from the card data instead of guessing at them", () => {
    const e = powerEstimate([solRing, { ...big, name: "Mystery", cmc: null, typeLine: null }], none)!;
    expect(e.unknownCards).toEqual(["Mystery"]);
  });
});
