import { describe, expect, it } from "vitest";
import type { Names } from "./feed";
import { doerOf } from "./HitCues";
import { hitCueMs, paceMessage, PLAY_SPEEDS } from "./motion";
import { happeningCards, hitsOnYou, reviewSteps } from "./review";
import type { Happening } from "./types";

const NAMES = ["You", "Worf", "Kraum", "Sephiroth"];
const n: Names = { you: 0, Who: (s) => NAMES[s] ?? `Seat ${s + 1}` };
let seq = 0;
const at = (turn: number, active: number, what: Record<string, unknown>): Happening => ({ seq: ++seq, turn, active, ...what }) as Happening;
const seen = (name: string, id?: number) => ({ name, ...(id !== undefined ? { id } : {}) });

describe("what was done to you", () => {
  const vindicate = at(14, 1, { kind: "moved", owner: 0, card: seen("Kinsbaile Cavalier", 4), from: "battlefield", to: "graveyard", how: "destroyed", by: seen("Vindicate", 90), by_seat: 1, creature: true });

  it("finds another player's spell taking your card, and who did it", () => {
    expect(hitsOnYou([vindicate], vindicate.seq - 1, 0)).toEqual([vindicate]);
    expect(doerOf(vindicate)).toBe(1);
    // Only what's new.
    expect(hitsOnYou([vindicate], vindicate.seq, 0)).toEqual([]);
    // Not someone else's card, and nothing for a spectator.
    expect(hitsOnYou([{ ...vindicate, owner: 2 } as Happening], 0, 0)).toEqual([]);
    expect(hitsOnYou([vindicate], 0, null)).toEqual([]);
  });

  it("leaves out what you did yourself and what combat already shows", () => {
    const own = at(5, 0, { kind: "moved", owner: 0, card: seen("Treasure"), from: "battlefield", to: "graveyard", how: "sacrificed" });
    const ownSpell = at(5, 0, { kind: "moved", owner: 0, card: seen("Sol Ring"), from: "battlefield", to: "exile", how: "moved", by: seen("Farewell"), by_seat: 0 });
    const combat = at(7, 2, { kind: "damage", source: seen("Ragavan"), by: 2, to: { kind: "player", seat: 0 }, amount: 2, combat: true });
    const cast = at(7, 2, { kind: "cast", seat: 2, card: seen("Chain of Vapor") });
    expect(hitsOnYou([own, ownSpell, combat, cast], 0, 0)).toEqual([]);
  });

  it("counts a creature of yours dying on someone else's turn, damage outside combat and theft, not life you paid", () => {
    const died = at(7, 2, { kind: "moved", owner: 0, card: seen("Squire"), from: "battlefield", to: "graveyard", how: "moved", creature: true });
    const bolt = at(7, 2, { kind: "damage", source: seen("Lightning Bolt"), by: 2, to: { kind: "card", card: seen("Squire", 3) }, amount: 3 });
    const steal = at(7, 2, { kind: "control", card: seen("Sol Ring", 8), from: 0, to: 2, by: seen("Treachery") });
    const drain = at(8, 3, { kind: "life", seat: 0, delta: -1, total: 37 });
    const mine = (id: number) => id === 3;
    expect(hitsOnYou([died, bolt, steal, drain], 0, 0, mine)).toEqual([died, bolt, steal]);
    // Damage to a creature that isn't yours isn't.
    expect(hitsOnYou([bolt], 0, 0, () => false)).toEqual([]);
  });

  it("shows the card that did it first", () => {
    expect(happeningCards(vindicate).map((c) => c.name)).toEqual(["Vindicate", "Kinsbaile Cavalier"]);
  });
});

describe("the timeline", () => {
  it("steps through everything since your last turn, each under its turn as the table counts it", () => {
    const rounds: [number, number][] = [[13, 4], [14, 4], [15, 4]];
    const t: Names = { ...n, turn: (x) => rounds.find((r) => r[0] === x)?.[1] ?? x };
    const events = [
      at(13, 0, { kind: "turn", seat: 0 }),
      at(13, 0, { kind: "cast", seat: 0, card: seen("Kinsbaile Cavalier") }),
      at(14, 1, { kind: "turn", seat: 1 }),
      at(14, 1, { kind: "cast", seat: 1, card: seen("Vindicate") }),
      at(14, 1, { kind: "moved", owner: 0, card: seen("Kinsbaile Cavalier", 4), from: "battlefield", to: "graveyard", how: "destroyed", by: seen("Vindicate"), by_seat: 1, creature: true }),
      at(15, 2, { kind: "turn", seat: 2 }),
      at(15, 2, { kind: "attack", seat: 2, attacks: [{ card: seen("Ragavan"), at: { kind: "player", seat: 1 } }] }),
    ];
    const steps = reviewSteps(events, t);
    expect(steps.map((s) => s.head)).toEqual(["Worf's turn 4", "Worf's turn 4", "Kraum's turn 4"]);
    expect(steps.map((s) => s.text)).toEqual(["Worf cast Vindicate.", "Worf's Vindicate destroyed your Kinsbaile Cavalier.", "Ragavan attacked Worf."]);
  });
});

describe("pacing", () => {
  it("asks the server to rest on the computer's moves by speed, and not at all while hidden", () => {
    expect(paceMessage("slow", false)).toEqual({ type: "pace", speed: "slow" });
    expect(paceMessage("normal", true)).toEqual({ type: "pace", speed: "instant" });
  });

  it("keeps a callout about you longest on Slow, and readable even on Instant", () => {
    const ms = PLAY_SPEEDS.map((s) => hitCueMs(s.scale));
    expect(ms).toEqual([9000, 4500, 2700, 2500]);
    expect([...ms].sort((a, b) => b - a)).toEqual(ms);
  });
});
