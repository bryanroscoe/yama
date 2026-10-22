import { describe, expect, it } from "vitest";
import { arcPath, attackDrop, blockDrop, dragSlop, handDrop, movedPast, parseDrop, pastPlayLine, targetDrop, targetIndex, HAND_PLAY_LINE } from "./drag";
import type { AttackAt, OptionView } from "./types";

const opt = (index: number, label: string, object: number | null = null): OptionView => ({ index, label, object });

describe("the play line", () => {
  it("is 64 px above the hand", () => {
    expect(HAND_PLAY_LINE).toBe(64);
    expect(pastPlayLine(900 - 65, 900)).toBe(true);
    expect(pastPlayLine(900 - 64, 900)).toBe(false);
    expect(pastPlayLine(950, 900)).toBe(false);
  });
  it("needs a real move before a press becomes a drag", () => {
    expect(dragSlop("mouse")).toBe(5);
    expect(dragSlop("touch")).toBe(10);
    expect(movedPast(0, 0, 3, 3, dragSlop("mouse"))).toBe(false);
    expect(movedPast(0, 0, 6, 0, dragSlop("mouse"))).toBe(true);
    expect(movedPast(0, 0, 6, 0, dragSlop("touch"))).toBe(false);
  });
});

describe("dropping a hand card", () => {
  const base = { passed: true, options: [] as OptionView[], deciding: true, combat: false, name: "Lightning Bolt" };
  it("plays the card when it has one way to be played", () => {
    const cast = opt(3, "Cast Lightning Bolt", 7);
    expect(handDrop({ ...base, options: [cast] })).toEqual({ act: "play", option: cast });
  });
  it("asks which way when there are several", () => {
    const a = opt(1, "Cast Bonecrusher Giant", 9);
    const b = opt(2, "Cast Stomp", 9);
    expect(handDrop({ ...base, options: [a, b] })).toEqual({ act: "choose", options: [a, b] });
  });
  it("goes back quietly when let go below the line", () => {
    expect(handDrop({ ...base, passed: false, options: [opt(1, "Cast it", 7)] })).toEqual({ act: "back", reason: null });
  });
  it("says why it can't be played", () => {
    expect(handDrop({ ...base, deciding: false })).toEqual({ act: "back", reason: "You can play Lightning Bolt when the game gets to you." });
    expect(handDrop({ ...base, combat: true })).toEqual({ act: "back", reason: "Finish declaring attackers or blockers first." });
    expect(handDrop(base)).toEqual({ act: "back", reason: "Lightning Bolt can't be played right now." });
  });
});

describe("what's under the pointer", () => {
  it("reads tile ids and the seat pane", () => {
    expect(parseDrop("12 13", "2")).toEqual({ ids: [12, 13], seat: 2 });
    expect(parseDrop(null, "0")).toEqual({ ids: null, seat: 0 });
    expect(parseDrop("", undefined)).toEqual({ ids: null, seat: null });
  });
});

describe("dropping an attacker", () => {
  const targets: AttackAt[] = [
    { kind: "player", seat: 1 },
    { kind: "player", seat: 2 },
    { kind: "planeswalker", id: 40 },
  ];
  it("attacks the player whose pane it lands in", () => {
    expect(attackDrop(targets, { ids: null, seat: 2 })).toEqual({ kind: "player", seat: 2 });
  });
  it("attacks a planeswalker when it lands on its tile", () => {
    expect(attackDrop(targets, { ids: [40], seat: 1 })).toEqual({ kind: "planeswalker", id: 40 });
  });
  it("attacks the pane's player when it lands on one of their creatures", () => {
    expect(attackDrop(targets, { ids: [55], seat: 1 })).toEqual({ kind: "player", seat: 1 });
  });
  it("does nothing off the opponents' panes or at a player it can't attack", () => {
    expect(attackDrop(targets, { ids: null, seat: null })).toBeNull();
    expect(attackDrop(targets, { ids: null, seat: 3 })).toBeNull();
  });
});

describe("dropping a blocker", () => {
  it("blocks an attacker it may block", () => {
    expect(blockDrop([20, 21], { ids: [21], seat: null })).toBe(21);
    expect(blockDrop([20, 21], { ids: [22], seat: null })).toBeNull();
    expect(blockDrop([20], { ids: null, seat: 1 })).toBeNull();
  });
  it("spreads blockers over a stack of attackers before doubling up", () => {
    expect(blockDrop([20, 21], { ids: [20, 21], seat: null }, [20])).toBe(21);
    expect(blockDrop([20, 21], { ids: [20, 21], seat: null }, [20, 21])).toBe(20);
  });
});

describe("dragging onto a target", () => {
  const cardTargets = new Map([[5, opt(4, "Target Grizzly Bears")]]);
  const seatTargets = new Map([[1, opt(5, "Target Sam")]]);
  const pick = (ids: number[] | null, seat: number | null) => targetDrop({ ids, seat }, (i) => cardTargets.get(i), (s) => seatTargets.get(s));
  it("picks a legal card target first", () => {
    expect(pick([5], 1)?.label).toBe("Target Grizzly Bears");
  });
  it("picks the player when the card isn't a legal target", () => {
    expect(pick([6], 1)?.label).toBe("Target Sam");
  });
  it("picks nothing elsewhere", () => {
    expect(pick([6], null)).toBeNull();
    expect(pick(null, 2)).toBeNull();
  });
});

describe("arrows", () => {
  it("curve off the straight line by at most 80 px", () => {
    expect(arcPath({ x: 0, y: 0 }, { x: 0, y: 100 })).toBe("M 0 0 Q -30 50 0 100");
    expect(arcPath({ x: 0, y: 0 }, { x: 1000, y: 0 })).toBe("M 0 0 Q 500 80 1000 0");
    expect(arcPath({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe("M 5 5 L 5 5");
  });
});

describe("target options", () => {
  it("keep two cards with the same name apart when the server says which is which", () => {
    const mine = { ...opt(1, "Target Savannah Lions (yours)"), target: { kind: "object" as const, id: 10 } };
    const theirs = { ...opt(2, "Target Savannah Lions (Sam's)"), target: { kind: "object" as const, id: 20 } };
    const sam = { ...opt(3, "Target Sam"), target: { kind: "player" as const, seat: 1 } };
    const t = targetIndex([opt(0, "Pass"), mine, theirs, sam, opt(4, "Cast Shock", 9)]);
    expect(t.byId.get(20)).toBe(theirs);
    expect(t.byId.get(10)).toBe(mine);
    expect(t.bySeat.get(1)).toBe(sam);
    expect(t.size).toBe(3);
  });
  it("fall back to names for older servers", () => {
    const t = targetIndex([opt(1, "Target Sol Ring"), opt(2, "Target Sol Ring")]);
    expect(t.byName.get("Sol Ring")?.index).toBe(1);
    expect(t.size).toBe(1);
  });
});
