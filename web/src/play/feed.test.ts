import { describe, expect, it } from "vitest";
import { cameText, faceOf, inspectorFacts, inspectorTabs, lastOut, lineText, logRows, outText, revealGroups, revealsAfter, sinceLastTurn, standings, whyText, type Names } from "./feed";
import type { CardView, Happening, Out, PlayerView, View } from "./types";

const NAMES = ["You", "Sam", "Jules", "Computer"];
const n: Names = { you: 0, Who: (s) => NAMES[s] ?? `Seat ${s + 1}` };

let seq = 0;
const at = (turn: number, active: number, what: Record<string, unknown>): Happening => ({ seq: ++seq, turn, active, ...what }) as Happening;
const seen = (name: string, id?: number) => ({ name, ...(id !== undefined ? { id } : {}) });

const card = (id: number, name: string, extra: Partial<CardView> = {}): CardView => ({
  id, name, controller: 0, owner: 0, tapped: false, power: null, toughness: null, loyalty: null, damage: 0, counters: {}, types: [], attached_to: null, ...extra,
});

const player = (seat: number, life = 40): PlayerView => ({ seat, life, poison: 0, hand: 7, library: 80, graveyard: [], eliminated: false, commander_damage: {} });

describe("lines in the log", () => {
  it("say what happened in plain words, from the viewer's side", () => {
    expect(lineText(at(8, 1, { kind: "cast", seat: 1, card: seen("Grave Titan") }), n)).toBe("Sam cast Grave Titan.");
    expect(lineText(at(9, 0, { kind: "land", seat: 0, card: seen("Plains") }), n)).toBe("You played Plains.");
    expect(lineText(at(8, 1, { kind: "damage", source: seen("Terra"), by: 1, to: { kind: "player", seat: 0 }, amount: 3, combat: true, life: [41, 38] }), n)).toBe(
      "Terra dealt 3 combat damage to you, 41 → 38.",
    );
    expect(lineText(at(8, 3, { kind: "life", seat: 2, delta: -6, total: 36 }), n)).toBe("Jules lost 6 life, 42 → 36.");
    expect(lineText(at(8, 3, { kind: "attack", seat: 3, attacks: [{ card: seen("Spirit"), at: { kind: "player", seat: 2 } }, { card: seen("Spirit"), at: { kind: "player", seat: 2 } }] }), n)).toBe(
      "Spirit ×2 attacked Jules.",
    );
    expect(lineText(at(8, 1, { kind: "token", seat: 1, card: seen("Zombie"), count: 2 }), n)).toBe("Sam created 2 Zombie tokens.");
    expect(lineText(at(8, 1, { kind: "token", seat: 1, card: seen("Elf Warrior"), count: 1 }), n)).toBe("Sam created an Elf Warrior token.");
    expect(lineText(at(8, 1, { kind: "counters", card: seen("Servant of the Scale"), counter: "plus1plus1", delta: 2 }), n)).toBe("Servant of the Scale got 2 +1/+1 counters.");
    expect(lineText(at(8, 1, { kind: "revealed", seat: 2, cards: [seen("Monastery Mentor")] }), n)).toBe("Jules revealed Monastery Mentor.");
    expect(lineText(at(8, 1, { kind: "looked", seat: 0, whose: 1, cards: [seen("Sol Ring"), seen("Counterspell")] }), n)).toBe("You looked at Sol Ring and Counterspell, from Sam's cards.");
    expect(lineText(at(8, 1, { kind: "automatic", seat: 0, name: "Rhystic Study", accept: true, answer: "m1" }), n)).toBe("Yama answered yes for Rhystic Study, as you asked.");
    expect(lineText(at(14, 0, { kind: "over" }), n)).toBe("The game is a draw.");
    expect(lineText(at(14, 0, { kind: "over", winner: 0 }), n)).toBe("You won.");
    expect(lineText(at(9, 3, { kind: "out", seat: 3 }), n)).toBe("Computer is out.");
    expect(lineText(at(9, 3, { kind: "out", seat: 0 }), n)).toBe("You are out.");
  });

  it("name draws only when the viewer was told the cards", () => {
    expect(lineText(at(9, 0, { kind: "drew", seat: 0, count: 1, cards: [seen("Chaos Warp", 5)] }), n)).toBe("You drew Chaos Warp.");
    expect(lineText(at(9, 1, { kind: "drew", seat: 1, count: 2, cards: [] }), n)).toBe("Sam drew 2 cards.");
    expect(lineText(at(9, 1, { kind: "drew", seat: 1, count: 1, cards: [] }), n)).toBe("Sam drew a card.");
  });

  it("give the engine's reason for a move, and say nothing for a spell resolving", () => {
    const move = (what: Record<string, unknown>) => lineText(at(5, 1, { kind: "moved", owner: 1, card: seen("Ashen Rider", 9), ...what }), n);
    expect(move({ from: "battlefield", to: "graveyard", how: "moved", creature: true })).toBe("Ashen Rider died.");
    expect(move({ from: "battlefield", to: "graveyard", how: "destroyed", by: seen("Doom Blade") })).toBe("Ashen Rider was destroyed by Doom Blade.");
    expect(move({ from: "hand", to: "graveyard", how: "discarded" })).toBe("Sam discarded Ashen Rider.");
    expect(move({ from: "library", to: "graveyard", how: "milled" })).toBe("Sam milled Ashen Rider.");
    expect(move({ from: "battlefield", to: "exile", how: "moved" })).toBe("Ashen Rider was exiled from the battlefield.");
    expect(move({ from: "battlefield", to: "hand", how: "moved" })).toBe("Ashen Rider returned to Sam's hand.");
    expect(move({ from: "stack", to: "graveyard", how: "moved" })).toBeNull();
    expect(move({ from: "stack", to: "graveyard", how: "countered", by: seen("Counterspell") })).toBe("Ashen Rider was countered by Counterspell.");
    expect(lineText(at(5, 1, { kind: "moved", owner: 1, card: {}, from: "battlefield", to: "exile", how: "moved" }), n)).toBe("a card was exiled from the battlefield.");
  });

  it("caption a card in a zone with how it got there", () => {
    expect(cameText({ turn: 8, how: "destroyed", from: "battlefield" })).toBe("Destroyed, turn 8");
    expect(cameText({ turn: 7, how: "moved", from: "stack" })).toBe("Cast, turn 7");
    expect(cameText({ turn: 6, how: "discarded", from: "hand" })).toBe("Discarded, turn 6");
    expect(cameText({ turn: 4, how: "milled", from: "library" })).toBe("Milled, turn 4");
    expect(cameText({ turn: 3, how: "moved", from: "battlefield" })).toBe("Left the battlefield, turn 3");
    expect(cameText({ turn: 7, how: "left", from: "library" })).toBe("Left the game with its owner, turn 7");
  });
});

describe("the log's filters", () => {
  // Turns 7 and 8 around the table, then your turn 9.
  seq = 0;
  const game: Happening[] = [
    at(7, 0, { kind: "turn", seat: 0 }),
    at(7, 0, { kind: "cast", seat: 0, card: seen("Swords to Plowshares") }),
    at(8, 1, { kind: "turn", seat: 1 }),
    at(8, 1, { kind: "cast", seat: 1, card: seen("Grave Titan") }),
    at(8, 1, { kind: "attack", seat: 1, attacks: [{ card: seen("Terra"), at: { kind: "player", seat: 0 } }] }),
    at(8, 1, { kind: "damage", source: seen("Terra"), by: 1, to: { kind: "player", seat: 0 }, amount: 3, combat: true, life: [41, 38] }),
    at(8, 2, { kind: "turn", seat: 2 }),
    at(8, 2, { kind: "cast", seat: 2, card: seen("Rhystic Study") }),
    at(8, 2, { kind: "drew", seat: 2, count: 1, cards: [] }),
    at(9, 0, { kind: "turn", seat: 0 }),
    at(9, 0, { kind: "drew", seat: 0, count: 1, cards: [seen("Chaos Warp")] }),
    at(9, 0, { kind: "automatic", seat: 0, name: "Rhystic Study", accept: true, answer: "m1" }),
  ];
  const texts = (f: Parameters<typeof logRows>[1]) => logRows(game, f, n).map((r) => (r.head ? `# ${NAMES[r.head.seat]} ${r.head.turn}` : r.text));

  it("since your last turn: everything after it ended, this turn included", () => {
    expect(sinceLastTurn(game, 0)).toBe(game[2]!.seq);
    expect(texts("since")).toEqual([
      "# Sam 8",
      "Sam cast Grave Titan.",
      "Terra attacked you.",
      "Terra dealt 3 combat damage to you, 41 → 38.",
      "# Jules 8",
      "Jules cast Rhystic Study.",
      "Jules drew a card.",
      "# You 9",
      "You drew Chaos Warp.",
      "Yama answered yes for Rhystic Study, as you asked.",
    ]);
    // Once your turn is over, from the next player's turn.
    expect(sinceLastTurn(game.slice(0, 5), 0)).toBe(game[2]!.seq);
    // Before your first turn is over: the whole game so far.
    expect(sinceLastTurn(game.slice(0, 2), 0)).toBe(0);
    // A spectator has no turn of their own.
    expect(sinceLastTurn(game, null)).toBe(0);
  });

  it("about me, spells and combat keep only their lines, with a heading for each turn that has one", () => {
    expect(texts("me")).toEqual([
      "# You 7",
      "You cast Swords to Plowshares.",
      "# Sam 8",
      "Terra attacked you.",
      "Terra dealt 3 combat damage to you, 41 → 38.",
      "# You 9",
      "You drew Chaos Warp.",
      "Yama answered yes for Rhystic Study, as you asked.",
    ]);
    expect(texts("spells")).toEqual(["# You 7", "You cast Swords to Plowshares.", "# Sam 8", "Sam cast Grave Titan.", "# Jules 8", "Jules cast Rhystic Study."]);
    expect(texts("combat")).toEqual(["# Sam 8", "Terra attacked you.", "Terra dealt 3 combat damage to you, 41 → 38."]);
    expect(texts("all")).toHaveLength(12);
  });

  it("heads lines from before the first turn the log holds with their own turn", () => {
    const early = [at(1, 2, { kind: "attack", seat: 2, attacks: [{ card: seen("Goblin Guide"), at: { kind: "player", seat: 0 } }] }), ...game];
    expect(logRows(early, "all", n)[0]).toEqual({ head: { seat: 2, turn: 1 } });
  });

  it("shows a run of reveals by one player as one panel", () => {
    const run = [
      at(9, 1, { kind: "revealed", seat: 0, cards: [seen("Forest")] }),
      at(9, 1, { kind: "revealed", seat: 0, cards: [seen("Island")] }),
      at(9, 1, { kind: "damage", source: seen("Goblin Guide"), by: 1, to: { kind: "player", seat: 0 }, amount: 2, combat: true }),
      at(9, 1, { kind: "revealed", seat: 2, cards: [seen("Mentor")] }),
      at(9, 1, { kind: "looked", seat: 0, cards: [seen("Bolt")] }),
    ];
    expect(revealGroups(run, 0).map((g) => g.map((h) => h.cards[0]!.name))).toEqual([["Forest", "Island"], ["Mentor"], ["Bolt"]]);
    expect(revealGroups(run, run[1]!.seq).length).toBe(2);
  });

  it("finds reveals newer than the last one shown", () => {
    const more = [...game, at(9, 0, { kind: "revealed", seat: 1, cards: [seen("Mentor")] }), at(9, 0, { kind: "looked", seat: 0, cards: [seen("Bolt")] })];
    expect(revealsAfter(more, 0).map((h) => h.kind)).toEqual(["revealed", "looked"]);
    expect(revealsAfter(more, more[more.length - 2]!.seq).map((h) => h.kind)).toEqual(["looked"]);
  });
});

describe("knockouts and the end", () => {
  const out = (seat: number, turn: number, batch: number, why: Out["why"], life = 0): Out => ({ seat, turn, life, why, inferred: why.kind !== "conceded" && why.kind !== "unknown", batch });

  it("say the cause, from your side of the table", () => {
    expect(outText(out(3, 9, 40, { kind: "commander", name: "Éowyn, Shieldmaiden", seat: 0, damage: 21 }, 26), n)).toBe("Out on turn 9: 21 commander damage from your Éowyn");
    expect(outText(out(0, 12, 90, { kind: "commander", name: "Terra, Herald of Hope", seat: 1, damage: 22 }), n)).toBe("Out on turn 12: 22 commander damage from Sam's Terra");
    expect(outText(out(2, 7, 30, { kind: "conceded" }), n)).toBe("Conceded on turn 7");
    expect(outText(out(2, 7, 30, { kind: "unknown" }), n)).toBe("Out on turn 7");
    expect(whyText({ kind: "poison", count: 10 }, n)).toBe("10 poison counters");
    expect(whyText({ kind: "library" }, n)).toBe("drew from an empty library");
  });

  it("rank the winner first and the first out last", () => {
    const players = [player(0, 17), player(1, 0), player(2, 0), player(3, 26)];
    const outs = [out(3, 9, 40, { kind: "commander", name: "Éowyn", seat: 0, damage: 21 }, 26), out(2, 11, 60, { kind: "life", life: 0 }), out(1, 14, 90, { kind: "life", life: 0 })];
    const s = standings(players, outs, 0, true, n);
    expect(s.map((r) => [r.seat, r.place, r.how])).toEqual([
      [0, "1", "Winner"],
      [1, "2", "Out on turn 14: at 0 life"],
      [2, "3", "Out on turn 11: at 0 life"],
      [3, "4", "Out on turn 9: 21 commander damage from your Éowyn"],
    ]);
    expect(lastOut(outs, n)).toBe("Sam, at 0 life");
    expect(lastOut([out(2, 8, 70, { kind: "conceded" })], n)).toBe("Jules, by conceding");
  });

  it("share first place when the last two go out together (a drawn game)", () => {
    const players = [player(0, 0), player(1, 0), player(2), player(3)];
    const outs = [out(3, 9, 40, { kind: "unknown" }), out(2, 13, 70, { kind: "life", life: -1 }), out(0, 15, 99, { kind: "life", life: 0 }), out(1, 15, 99, { kind: "life", life: 0 })];
    const s = standings(players, outs, null, true, n);
    expect(s.map((r) => [r.seat, r.place])).toEqual([
      [0, "=1"],
      [1, "=1"],
      [2, "3"],
      [3, "4"],
    ]);
  });

  it("leave players still in without a place while the game goes on", () => {
    const s = standings([player(0, 18), player(1, 22), player(2)], [out(2, 9, 40, { kind: "life", life: 0 })], null, false, n);
    expect(s.map((r) => [r.seat, r.place, r.how])).toEqual([
      [0, "", "Playing, 18 life"],
      [1, "", "Playing, 22 life"],
      [2, "3", "Out on turn 9: at 0 life"],
    ]);
  });
});

describe("reading a card", () => {
  it("shows one face of a two-faced card at a time", () => {
    const text = "Flying\nAt the beginning of your upkeep, transform it.\n//\nFlying";
    expect(faceOf(text, "Creature — Human Wizard // Creature — Human Insect", false)).toEqual({ text: "Flying\nAt the beginning of your upkeep, transform it.", type: "Creature — Human Wizard", faces: 2 });
    expect(faceOf(text, "Creature — Human Wizard // Creature — Human Insect", true)).toEqual({ text: "Flying", type: "Creature — Human Insect", faces: 2 });
    expect(faceOf("Draw a card.", "Instant", true)).toEqual({ text: "Draw a card.", type: "Instant", faces: 1 });
  });

  it("has a battlefield tab only for a permanent", () => {
    expect(inspectorTabs(card(1, "Bear"), true).map((t) => t.id)).toEqual(["text", "now", "rulings"]);
    expect(inspectorTabs(card(1, "Bolt"), false).map((t) => t.id)).toEqual(["text", "rulings"]);
    // A stack item read from the rail has no card of its own.
    expect(inspectorTabs(card(-1, "Bolt"), true).map((t) => t.id)).toEqual(["text", "rulings"]);
  });

  it("lists a creature's state: counters, damage, its aura, who controls it", () => {
    const bear = card(5, "Grizzly Bears", { power: 4, toughness: 4, base_power: 2, base_toughness: 2, damage: 1, counters: { plus1plus1: 1 }, attachments: [6], controller: 0, owner: 1, entered: 6, tapped: true });
    const aura = card(6, "Rancor", { attached_to: { type: "Object", data: 5 } });
    const view = { battlefield: [bear, aura] } as unknown as View;
    const byId = new Map([bear, aura].map((c) => [c.id, c]));
    expect(inspectorFacts(bear, view, n, byId, 0)).toEqual([
      { k: "Power and toughness", v: "4/4, base 2/2" },
      { k: "Damage this turn", v: "1" },
      { k: "Counters", v: "1 +1/+1" },
      { k: "Controller and owner", v: "You control it; Sam owns it" },
      { k: "Attached", v: "Rancor" },
      { k: "Tapped", v: "Tapped" },
      { k: "Entered the battlefield", v: "Turn 6" },
    ]);
    expect(inspectorFacts(aura, view, n, byId, 0).find((r) => r.k === "Attached")).toEqual({ k: "Attached", v: "Attached to Grizzly Bears" });
    const commander = card(7, "Éowyn", { power: 5, toughness: 4, commander: true });
    expect(inspectorFacts(commander, view, n, byId, 2).find((r) => r.k === "Commander tax")).toEqual({ k: "Commander tax", v: "{2} for the next cast" });
  });
});
