import { describe, expect, it } from "vitest";
import { deltaText, dur, lifeChanges, lifeOf, motionScale, stackChange, tickValue, turnBegan, zonesOf } from "./motion";
import type { CardView, PlayerView, View } from "./types";

const card = (id: number, extra: Partial<CardView> = {}): CardView => ({
  id,
  name: `Card ${id}`,
  controller: 0,
  owner: 0,
  tapped: false,
  power: null,
  toughness: null,
  loyalty: null,
  damage: 0,
  counters: {},
  types: [],
  attached_to: null,
  ...extra,
});
const player = (seat: number, life: number, graveyard: CardView[] = []): PlayerView => ({
  seat,
  life,
  poison: 0,
  hand: 0,
  library: 90,
  graveyard,
  eliminated: false,
  commander_damage: {},
});
const view = (extra: Partial<View> = {}): View => ({
  revision: 1,
  turn: 3,
  active: 0,
  phase: "PreCombatMain",
  waiting_on: [0],
  waiting: "",
  players: [player(0, 40), player(1, 40)],
  battlefield: [],
  stack: [],
  command_zone: [],
  exile: [],
  hand: [],
  decision: null,
  log: [],
  over: false,
  winner: null,
  ...extra,
});

describe("motion speed", () => {
  it("is off for reduced motion, a hidden tab and watching to the end", () => {
    expect(motionScale({ reduced: true, hidden: false })).toBe(0);
    expect(motionScale({ reduced: false, hidden: true })).toBe(0);
    expect(motionScale({ reduced: false, hidden: false, speed: "end" })).toBe(0);
  });
  it("is normal while playing and shorter when watching fast", () => {
    expect(motionScale({ reduced: false, hidden: false })).toBe(1);
    expect(motionScale({ reduced: false, hidden: false, speed: "1x" })).toBe(1);
    expect(motionScale({ reduced: false, hidden: false, speed: "2x" })).toBeLessThan(1);
    expect(motionScale({ reduced: false, hidden: false, speed: "4x" })).toBeLessThan(motionScale({ reduced: false, hidden: false, speed: "2x" }));
    expect(dur(320, 0.35)).toBe(112);
  });
});

describe("where cards are", () => {
  it("finds every visible zone by id", () => {
    const v = view({
      battlefield: [card(1, { controller: 1 })],
      hand: [card(2)],
      exile: [card(3, { owner: 1 })],
      command_zone: [card(4)],
      players: [player(0, 40, [card(5)]), player(1, 40)],
    });
    const z = zonesOf(v, 0);
    expect(z.get(1)).toEqual({ zone: "battlefield", seat: 1 });
    expect(z.get(2)).toEqual({ zone: "hand", seat: 0 });
    expect(z.get(3)).toEqual({ zone: "exile", seat: 1 });
    expect(z.get(4)).toEqual({ zone: "command", seat: 0 });
    expect(z.get(5)).toEqual({ zone: "graveyard", seat: 0 });
  });
  it("leaves your hand out when you're only watching, unless hands are face up", () => {
    expect(zonesOf(view({ hand: [card(2)] }), null).has(2)).toBe(false);
    expect(zonesOf(view({ hands: { "1": [card(9)] } }), null).get(9)).toEqual({ zone: "hand", seat: 1 });
  });
});

describe("life changes", () => {
  it("lists only the totals that moved", () => {
    const before = lifeOf(view());
    const after = view({ players: [player(0, 37), player(1, 42)] });
    expect(lifeChanges(before, after)).toEqual([
      { seat: 0, delta: -3 },
      { seat: 1, delta: 2 },
    ]);
    expect(lifeChanges(null, after)).toEqual([]);
    expect(lifeChanges(lifeOf(after), after)).toEqual([]);
  });
  it("reads as a signed number and ticks with an ease-out", () => {
    expect(deltaText(-3)).toBe("−3");
    expect(deltaText(2)).toBe("+2");
    expect(tickValue(40, 30, 0)).toBe(40);
    expect(tickValue(40, 30, 1)).toBe(30);
    expect(tickValue(40, 30, 0.5)).toBe(33);
    expect(tickValue(40, 30, 2)).toBe(30);
  });
});

describe("the stack", () => {
  const bolt = { name: "Lightning Bolt", controller: 1 };
  const growth = { name: "Giant Growth", controller: 0 };
  it("sees a new item on top", () => {
    expect(stackChange([bolt], [bolt, growth])).toEqual({ left: 0, added: [growth] });
  });
  it("sees the top item resolve", () => {
    expect(stackChange([bolt, growth], [bolt])).toEqual({ left: 1, added: [] });
    expect(stackChange([bolt, growth], [])).toEqual({ left: 2, added: [] });
  });
  it("sees a resolve and a new response in one board", () => {
    expect(stackChange([bolt, growth], [bolt, bolt])).toEqual({ left: 1, added: [bolt] });
  });
});

describe("turns", () => {
  it("begin when the turn number or the active seat changes to yours", () => {
    expect(turnBegan({ turn: 2, active: 1 }, view({ turn: 3, active: 0 }), 0)).toBe(true);
    expect(turnBegan({ turn: 3, active: 0 }, view({ turn: 3, active: 0 }), 0)).toBe(false);
    expect(turnBegan({ turn: 2, active: 0 }, view({ turn: 3, active: 1 }), 0)).toBe(false);
    expect(turnBegan(null, view(), 0)).toBe(false);
    expect(turnBegan({ turn: 2, active: 1 }, view(), null)).toBe(false);
  });
});
