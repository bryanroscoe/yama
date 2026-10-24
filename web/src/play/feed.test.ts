import { describe, expect, it } from "vitest";
import { cameText, faceOf, inspectorFacts, inspectorTabs, revealGroups, revealsAfter, type Names } from "./feed";
import type { CardView, Happening, View } from "./types";

const NAMES = ["You", "Sam", "Jules", "Computer"];
const n: Names = { you: 0, Who: (s) => NAMES[s] ?? `Seat ${s + 1}` };

let seq = 0;
const at = (turn: number, active: number, what: Record<string, unknown>): Happening => ({ seq: ++seq, turn, active, ...what }) as Happening;
const seen = (name: string, id?: number) => ({ name, ...(id !== undefined ? { id } : {}) });

const card = (id: number, name: string, extra: Partial<CardView> = {}): CardView => ({
  id, name, controller: 0, owner: 0, tapped: false, power: null, toughness: null, loyalty: null, damage: 0, counters: {}, types: [], attached_to: null, ...extra,
});

describe("zones", () => {
  it("caption a card in a zone with how it got there", () => {
    expect(cameText({ turn: 8, how: "destroyed", from: "battlefield" })).toBe("Destroyed, turn 8");
    expect(cameText({ turn: 7, how: "moved", from: "stack" })).toBe("Cast, turn 7");
    expect(cameText({ turn: 6, how: "discarded", from: "hand" })).toBe("Discarded, turn 6");
    expect(cameText({ turn: 4, how: "milled", from: "library" })).toBe("Milled, turn 4");
    expect(cameText({ turn: 3, how: "moved", from: "battlefield" })).toBe("Left the battlefield, turn 3");
    expect(cameText({ turn: 7, how: "left", from: "library" })).toBe("Left the game with its owner, turn 7");
  });
});

describe("reveals", () => {
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
    const more = [at(9, 0, { kind: "cast", seat: 0, card: seen("Bolt") }), at(9, 0, { kind: "revealed", seat: 1, cards: [seen("Mentor")] }), at(9, 0, { kind: "looked", seat: 0, cards: [seen("Bolt")] })];
    expect(revealsAfter(more, 0).map((h) => h.kind)).toEqual(["revealed", "looked"]);
    expect(revealsAfter(more, more[more.length - 2]!.seq).map((h) => h.kind)).toEqual(["looked"]);
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
