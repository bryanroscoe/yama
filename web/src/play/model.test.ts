import { describe, expect, it } from "vitest";
import {
  combatLines,
  combatText,
  DEFAULT_STOPS,
  landColors,
  landSummary,
  passLabel,
  realDecision,
  rows,
  stackPermanents,
  stepIndex,
  stopsMessage,
  stopsSummary,
  turnOrder,
} from "./model";
import { PREVIEW_H, PREVIEW_W, previewPlace } from "./model";
import type { CardMeta, CardView, PlayerView, View } from "./types";

const card = (id: number, name: string, extra: Partial<CardView> = {}): CardView => ({
  id,
  name,
  controller: 0,
  owner: 0,
  tapped: false,
  power: null,
  toughness: null,
  loyalty: null,
  damage: 0,
  counters: {},
  types: ["Land"],
  attached_to: null,
  ...extra,
});
const creature = (id: number, name: string, extra: Partial<CardView> = {}) => card(id, name, { types: ["Creature"], power: 1, toughness: 1, ...extra });
const player = (seat: number): PlayerView => ({ seat, life: 40, poison: 0, hand: 7, library: 92, graveyard: [], eliminated: false, commander_damage: {} });
const meta = (type_line: string, oracle_text: string): CardMeta => ({ oracle_id: "x", image: null, back_image: null, mana_cost: null, type_line, oracle_text });

describe("turnOrder", () => {
  it("lists opponents from the next seat round to the previous one", () => {
    const players = [0, 1, 2, 3].map(player);
    expect(turnOrder(players, 0).map((p) => p.seat)).toEqual([1, 2, 3]);
    expect(turnOrder(players, 2).map((p) => p.seat)).toEqual([3, 0, 1]);
  });
});

describe("stackPermanents", () => {
  it("stacks identical tokens and keeps tapped copies apart", () => {
    const piles = stackPermanents([
      creature(1, "Human Soldier"),
      creature(2, "Human Soldier"),
      creature(3, "Human Soldier", { tapped: true }),
      creature(4, "Human Soldier", { counters: { plus1plus1: 1 } }),
    ]);
    expect(piles.map((p) => p.ids)).toEqual([[1, 2], [3], [4]]);
  });
  it("never stacks a commander, an attachment or the card it's attached to", () => {
    const piles = stackPermanents([
      creature(1, "Bear"),
      creature(2, "Bear"),
      card(3, "Rancor", { types: ["Enchantment"], attached_to: { Object: 2 } }),
      creature(4, "Éowyn, Shieldmaiden", { commander: true }),
    ]);
    expect(piles.map((p) => p.ids)).toEqual([[1], [2], [3], [4]]);
  });
  it("keeps attackers apart from creatures staying home", () => {
    const piles = stackPermanents([creature(1, "Knight", { attacking: true, attacks: 2 }), creature(2, "Knight")]);
    expect(piles).toHaveLength(2);
  });
});

describe("rows", () => {
  it("puts creatures, lands and the rest in their rows, planeswalkers first among the rest", () => {
    const r = rows([
      card(5, "Sol Ring", { types: ["Artifact"] }),
      card(2, "Plains", { tapped: true }),
      card(1, "Plains"),
      creature(9, "Bear"),
      card(7, "Jace", { types: ["Planeswalker"], loyalty: 3 }),
      card(8, "Dryad Arbor", { types: ["Land", "Creature"], power: 1, toughness: 1 }),
    ]);
    expect(r.creatures.map((p) => p.card.name)).toEqual(["Dryad Arbor", "Bear"]);
    expect(r.lands.map((p) => [p.card.name, p.card.tapped])).toEqual([["Plains", false], ["Plains", true]]);
    expect(r.others.map((p) => p.card.name)).toEqual(["Jace", "Sol Ring"]);
  });
});

describe("landColors", () => {
  it("reads basic land types and the mana a land adds", () => {
    expect(landColors("Plains", meta("Basic Land — Plains", "({T}: Add {W}.)"))).toBe("W");
    expect(landColors("Battlefield Forge", meta("Land", "{T}: Add {C}.\n{T}: Add {R} or {W}. Battlefield Forge deals 1 damage to you."))).toBe("WR");
    expect(landColors("Command Tower", meta("Land", "{T}: Add one mana of any color in your commander's color identity."))).toBe("*");
    expect(landColors("Rogue's Passage", meta("Land", "{T}: Add {C}.\n{4}, {T}: Target creature can't be blocked this turn."))).toBe("C");
    expect(landColors("Island", undefined)).toBe("U");
  });
  it("sums untapped lands by color", () => {
    const m = { Plains: meta("Basic Land — Plains", ""), Island: meta("Basic Land — Island", "") };
    const s = landSummary([card(1, "Plains"), card(2, "Plains"), card(3, "Island", { tapped: true })], m);
    expect(s).toEqual({ groups: [{ colors: "W", count: 2 }], untapped: 2, total: 3 });
  });
});

describe("combat", () => {
  it("sums attackers by who they attack and says it from your side", () => {
    const lines = combatLines([
      creature(1, "A", { controller: 0, attacking: true, attacks: 2, power: 5 }),
      creature(2, "B", { controller: 0, attacking: true, attacks: 2, power: 4 }),
      creature(3, "C", { controller: 1, attacking: true, attacks: 0, power: 3 }),
    ]);
    const name = (n: number) => ["you", "Sam", "Priya"][n]!;
    expect(lines.map((l) => combatText(l, name, 0))).toEqual(["Attacking Priya with 2 creatures, 9 power", "Sam attacks you with 1 creature, 3 power"]);
  });
});

const view = (patch: Partial<View>): View => ({
  revision: 1,
  turn: 3,
  active: 0,
  phase: "PreCombatMain",
  waiting_on: [0],
  waiting: "",
  players: [player(0), player(1)],
  battlefield: [],
  stack: [],
  command_zone: [],
  exile: [],
  hand: [],
  decision: null,
  log: [],
  over: false,
  winner: null,
  ...patch,
});

describe("passLabel", () => {
  it("says what passing will do", () => {
    expect(passLabel(view({ stack: [{ name: "Sol Ring", controller: 1 }] }), 0)).toBe("Resolve");
    expect(passLabel(view({ active: 1 }), 0)).toBe("Pass");
    expect(passLabel(view({}), 0)).toBe("Next");
    expect(passLabel(view({ battlefield: [creature(1, "Bear")] }), 0)).toBe("To combat");
    expect(passLabel(view({ battlefield: [creature(1, "Bear", { sick: true })] }), 0)).toBe("Next");
    expect(passLabel(view({ phase: "PostCombatMain" }), 0)).toBe("End turn");
  });
  it("hides a decision whose only choice is to pass", () => {
    expect(realDecision({ revision: 1, prompt: "Priority", options: [{ index: 0, label: "Pass (move on)", object: null }] })).toBeNull();
  });
});

describe("stops", () => {
  it("knows the steps by engine phase, untap and cleanup folded in", () => {
    expect(stepIndex("Untap")).toBe(0);
    expect(stepIndex("EndCombat")).toBe(6);
    expect(stepIndex("Cleanup")).toBe(8);
  });
  it("sends nothing for the usual stops and engine phases for your own", () => {
    expect(stopsMessage(null)).toBeNull();
    expect(stopsMessage(DEFAULT_STOPS)).toBeNull();
    const mine = { ...DEFAULT_STOPS, Blockers: { mine: true, opp: false }, Upkeep: { mine: false, opp: true } };
    expect(stopsMessage(mine)).toEqual({ own: ["PreCombatMain", "DeclareBlockers", "PostCombatMain"], others: ["Upkeep", "End"] });
    expect(stopsSummary(mine)).toBe("Also stops on opponents' upkeep and your blockers step");
    expect(stopsSummary({ ...DEFAULT_STOPS, End: { mine: false, opp: false } })).toBe("Skips opponents' end step");
  });
});

describe("previewPlace", () => {
  const rect = (left: number, top: number, width = 90, height = 126) => ({ left, top, width, height, right: left + width, bottom: top + height });
  it("puts a hand card's preview just above it, centred on it", () => {
    const p = previewPlace(rect(1200, 1000), 1600, 1060);
    expect(p.top).toBe(1000 - 12 - PREVIEW_H);
    expect(p.left).toBe(1200 + 45 - PREVIEW_W / 2);
  });
  it("puts a battlefield card's preview to its right", () => {
    const p = previewPlace(rect(300, 200), 1600, 1060);
    expect(p.left).toBe(390 + 12);
  });
  it("uses the left side at the right edge, and stays inside the window", () => {
    const p = previewPlace(rect(1480, 200), 1600, 1060);
    expect(p.left).toBe(1480 - 12 - PREVIEW_W);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + PREVIEW_H).toBeLessThanOrEqual(1060 - 8);
  });
});
