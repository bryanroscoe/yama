import { describe, expect, it } from "vitest";
import { combatCues, enqueueCombatCues } from "./combatPresentation";
import type { Happening } from "./types";

const attack: Happening = { kind: "attack", seq: 10, turn: 3, active: 1, seat: 1, attacks: [{ card: { id: 5, name: "Serra Angel" }, at: { kind: "player", seat: 0 } }] };
const block: Happening = { kind: "block", seq: 11, turn: 3, active: 1, seat: 0, blocks: [[{ id: 3, name: "Bird" }, { id: 5, name: "Serra Angel" }]] };
const damage: Happening = { kind: "damage", seq: 12, turn: 3, active: 1, source: { id: 5, name: "Serra Angel" }, by: 1, to: { kind: "player", seat: 0 }, amount: 7, combat: true, life: [40, 33] };

describe("combat presentation", () => {
  it("keeps attack, blockers and impact in order even when one board contains all three", () => {
    const cues = combatCues([attack, block, damage], 9);
    expect(cues.map((c) => c.kind)).toEqual(["attack", "block", "damage"]);
    expect(cues[2]!.events[0]).toEqual(damage);
  });
  it("does not replay old events when the same board or reconnect history arrives", () => {
    expect(combatCues([attack, block, damage], 12)).toEqual([]);
    expect(combatCues([attack, block, damage], 11).map((c) => c.kind)).toEqual(["damage"]);
  });
  it("groups simultaneous hits and retains exact source, recipient and actual amount", () => {
    const toCreature: Happening = { ...damage, seq: 13, to: { kind: "card", card: { id: 3 } }, amount: 4 };
    expect(combatCues([damage, toCreature], 11)).toEqual([{ kind: "damage", events: [damage, toCreature] }]);
  });
  it("includes spell damage but skips empty declarations and prevented damage", () => {
    const spell: Happening = { ...damage, seq: 15, combat: false };
    expect(combatCues([{ ...attack, attacks: [] }, { ...block, blocks: [] }, { ...damage, amount: 0 }, spell], 9)).toEqual([{ kind: "damage", events: [spell] }]);
  });
  it("never supplies identities for hidden event sources", () => {
    const hidden: Happening = { ...damage, source: { face_down: true } };
    expect(combatCues([hidden], 11)[0]!.events[0]).toEqual(hidden);
  });
});

it("bounds fast-forward backlogs and points to the full log without losing the newest cues", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: "attack" as const, events: [{ ...attack, seq: i + 1 }] }));
  const queue = enqueueCombatCues([], many);
  expect(queue).toHaveLength(8);
  expect(queue[1]).toMatchObject({ kind: "summary", omitted: 30 });
  expect(queue.at(-1)!.events[0]!.seq).toBe(40);
});

it("does not restart the currently displayed cue on each incoming board", () => {
  const current = { kind: "attack" as const, events: [attack] };
  expect(enqueueCombatCues([current], [{ kind: "damage", events: [damage] }])[0]).toBe(current);
});
