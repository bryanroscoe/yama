import { describe, expect, it } from "vitest";
import { cancelAim, isLegal, legalDefenders, onlyDefender, pressAttacker, pressDefender, type AimState } from "./attackAim";
import type { AttackAt } from "./types";

const p = (seat: number): AttackAt => ({ kind: "player", seat });
const pw = (id: number): AttackAt => ({ kind: "planeswalker", id });

// A four-player Commander game: you are seat 0; creatures 10 and 11 may attack any opponent or
// seat 2's planeswalker 50, the token stack 12/13 may attack only players, 14 can only attack seat 1.
const multi = (over: Partial<AimState> = {}): AimState => ({
  valid: new Map<number, AttackAt[]>([
    [10, [p(1), p(2), p(3), pw(50)]],
    [11, [p(1), p(2), p(3), pw(50)]],
    [12, [p(1), p(2), p(3)]],
    [13, [p(1), p(2), p(3)]],
    [14, [p(1)]],
  ]),
  plan: new Map(),
  waiting: [],
  defender: p(1),
  must: new Map(),
  ...over,
});

describe("picking up an attacker", () => {
  it("waits for whom it attacks when it has a choice", () => {
    const r = pressAttacker(multi(), [10]);
    expect(r.waiting).toEqual([10]);
    expect(r.plan.size).toBe(0);
    expect(r.warn).toBeNull();
  });

  it("picks up a stack of tokens whole, and several tiles together", () => {
    const a = pressAttacker(multi(), [12, 13]);
    expect(a.waiting).toEqual([12, 13]);
    const b = pressAttacker(multi({ waiting: a.waiting }), [10]);
    expect(b.waiting).toEqual([12, 13, 10]);
  });

  it("goes straight to the only place it can attack, and back out on a second click", () => {
    const a = pressAttacker(multi(), [14]);
    expect(a.waiting).toEqual([]);
    expect(a.plan.get(14)).toEqual(p(1));
    const b = pressAttacker(multi({ plan: a.plan }), [14]);
    expect(b.plan.has(14)).toBe(false);
  });

  it("assigns a two-player game's attacker on one click without changing what else waits", () => {
    const duel: AimState = { valid: new Map([[1, [p(1)]], [2, [p(1)]]]), plan: new Map(), waiting: [], defender: p(1), must: new Map() };
    const r = pressAttacker(duel, [1]);
    expect(r.plan.get(1)).toEqual(p(1));
    expect(r.waiting).toEqual([]);
  });

  it("puts a waiting creature down on a second click, out of the attack", () => {
    const fresh = pressAttacker(multi({ waiting: [10] }), [10]);
    expect(fresh.waiting).toEqual([]);
    expect(fresh.plan.size).toBe(0);
    const planned = pressAttacker(multi({ waiting: [10, 11], plan: new Map([[10, p(2)]]) }), [10]);
    expect(planned.waiting).toEqual([11]);
    expect(planned.plan.has(10)).toBe(false);
  });

  it("picks an attacker that already attacks up again, keeping its place until it's sent elsewhere", () => {
    const r = pressAttacker(multi({ plan: new Map([[10, p(2)]]) }), [10]);
    expect(r.waiting).toEqual([10]);
    expect(r.plan.get(10)).toEqual(p(2));
    const moved = pressDefender(multi({ plan: r.plan, waiting: r.waiting }), p(3));
    expect(moved.plan.get(10)).toEqual(p(3));
    expect(moved.waiting).toEqual([]);
  });

  it("keeps a creature that must attack in the attack and says so", () => {
    const must = new Map([[10, [] as AttackAt[]]]);
    const r = pressAttacker(multi({ waiting: [10], plan: new Map([[10, p(1)]]), must }), [10]);
    expect(r.plan.get(10)).toEqual(p(1));
    expect(r.waiting).toEqual([]);
    expect(r.warn).toEqual({ kind: "must", id: 10 });
    const only = pressAttacker(multi({ plan: new Map([[14, p(1)]]), must: new Map([[14, []]]) }), [14]);
    expect(only.plan.get(14)).toEqual(p(1));
    expect(only.warn).toEqual({ kind: "must", id: 14 });
  });

  it("ignores creatures that can't attack", () => {
    const r = pressAttacker(multi(), [99]);
    expect(r.waiting).toEqual([]);
    expect(r.plan.size).toBe(0);
  });
});

describe("choosing whom it attacks", () => {
  it("sends every waiting creature at the player chosen, who becomes the one A aims at", () => {
    const r = pressDefender(multi({ waiting: [10, 12, 13] }), p(3));
    expect([...r.plan.entries()]).toEqual([[10, p(3)], [12, p(3)], [13, p(3)]]);
    expect(r.waiting).toEqual([]);
    expect(r.defender).toEqual(p(3));
    expect(r.warn).toBeNull();
  });

  it("sends at a planeswalker only the creatures that may attack it, and the rest keep waiting", () => {
    const r = pressDefender(multi({ waiting: [10, 12] }), pw(50));
    expect(r.plan.get(10)).toEqual(pw(50));
    expect(r.plan.has(12)).toBe(false);
    expect(r.waiting).toEqual([12]);
    expect(r.warn).toEqual({ kind: "cant", id: 12, at: pw(50) });
  });

  it("does nothing on somewhere none of them may attack", () => {
    const s = multi({ waiting: [12] });
    const r = pressDefender(s, pw(50));
    expect(r.plan.size).toBe(0);
    expect(r.waiting).toEqual([12]);
    expect(r.defender).toEqual(p(1));
    expect(r.warn).toBeNull();
  });

  it("warns when a creature that must attack someone is sent at someone else", () => {
    const r = pressDefender(multi({ waiting: [10], must: new Map([[10, [p(2)]]]) }), p(3));
    expect(r.plan.get(10)).toEqual(p(3));
    expect(r.warn).toEqual({ kind: "mustAt", id: 10, at: p(2) });
    const ok = pressDefender(multi({ waiting: [10], must: new Map([[10, [p(2)]]]) }), p(2));
    expect(ok.warn).toBeNull();
  });

  it("with nothing waiting, aims A at a defender someone may attack", () => {
    expect(pressDefender(multi(), p(2)).defender).toEqual(p(2));
    expect(pressDefender(multi(), p(7)).defender).toEqual(p(1));
    expect(pressDefender(multi(), p(2)).plan.size).toBe(0);
  });
});

describe("rings and cancelling", () => {
  it("rings every place at least one waiting creature may attack", () => {
    expect(legalDefenders(multi().valid, [12])).toEqual([p(1), p(2), p(3)]);
    expect(legalDefenders(multi().valid, [12, 10])).toEqual([p(1), p(2), p(3), pw(50)]);
    expect(legalDefenders(multi().valid, [])).toEqual([]);
    expect(isLegal(multi().valid, [12], pw(50))).toBe(false);
    expect(isLegal(multi().valid, [12, 10], pw(50))).toBe(true);
  });

  it("knows when there's only one place to go", () => {
    const v = multi().valid;
    expect(onlyDefender(v, [14])).toEqual(p(1));
    expect(onlyDefender(v, [10])).toBeNull();
    expect(onlyDefender(new Map([[1, [p(1)]], [2, [p(2)]]]), [1, 2])).toBeNull();
  });

  it("puts everything waiting down and leaves the attack as it was", () => {
    const r = cancelAim(multi({ waiting: [10, 11], plan: new Map([[10, p(2)]]) }));
    expect(r.waiting).toEqual([]);
    expect(r.plan.get(10)).toEqual(p(2));
  });
});
