// Choosing whom each attacker attacks (GAttack), the pure part: Board.tsx draws it. Click (or tap)
// one of your creatures and a dotted line runs from it to the pointer; click a player, a
// planeswalker or a battle it may attack and it attacks that. Click more creatures first to send
// them together. A creature with only one place to attack (a two-player game) goes straight there.
// Clicking a waiting creature again puts it down: out of the attack if it was in it, unless it
// must attack. Clicking one that already attacks picks it up again, to send it somewhere else.

import { sameTarget } from "./model";
import type { AttackAt } from "./types";

export interface AimState {
  /** Each creature that may attack, and where. */
  valid: ReadonlyMap<number, readonly AttackAt[]>;
  /** The attack built so far. */
  plan: ReadonlyMap<number, AttackAt>;
  /** Creatures picked up and waiting to be told whom they attack, in the order they were picked. */
  waiting: readonly number[];
  /** Whom "A" and "Everything at" send everything at: the last defender chosen. */
  defender: AttackAt | null;
  /** Creatures that attack this combat if able, with the defenders they must attack ([]: anyone). */
  must: ReadonlyMap<number, readonly AttackAt[]>;
}

/** Something to say in red: a creature that must attack, or one that can't attack there. */
export type AimWarn = { kind: "must"; id: number } | { kind: "mustAt"; id: number; at: AttackAt } | { kind: "cant"; id: number; at: AttackAt };

export interface AimResult {
  plan: Map<number, AttackAt>;
  waiting: number[];
  defender: AttackAt | null;
  warn: AimWarn | null;
}

const result = (s: AimState, change: Partial<AimResult>): AimResult => ({
  plan: new Map(s.plan),
  waiting: [...s.waiting],
  defender: s.defender,
  warn: null,
  ...change,
});

/** The one place these creatures can attack, when there is only one (and it's the same for all). */
export function onlyDefender(valid: AimState["valid"], ids: readonly number[]): AttackAt | null {
  let only: AttackAt | null = null;
  for (const id of ids) {
    const ts = valid.get(id);
    if (!ts || ts.length !== 1) return null;
    if (only && !sameTarget(only, ts[0]!)) return null;
    only = ts[0]!;
  }
  return only;
}

/** Every place at least one waiting creature may attack: these get a ring, nothing else does. */
export function legalDefenders(valid: AimState["valid"], waiting: readonly number[]): AttackAt[] {
  const out: AttackAt[] = [];
  for (const id of waiting) for (const t of valid.get(id) ?? []) if (!out.some((x) => sameTarget(x, t))) out.push(t);
  return out;
}

export function isLegal(valid: AimState["valid"], waiting: readonly number[], t: AttackAt): boolean {
  return waiting.some((id) => valid.get(id)?.some((x) => sameTarget(x, t)));
}

/**
 * A click or tap on one of your creatures (`ids`: a tile, which is a stack of identical tokens).
 * Those that can't attack are left to the caller, which says why.
 */
export function pressAttacker(s: AimState, ids: readonly number[]): AimResult {
  const able = ids.filter((i) => s.valid.has(i));
  if (!able.length) return result(s, {});
  const plan = new Map(s.plan);
  const only = onlyDefender(s.valid, able);
  if (only) {
    // Only one place to go: in, or back out once they're all in (the two-player game).
    const allIn = able.every((i) => {
      const at = plan.get(i);
      return !!at && sameTarget(at, only);
    });
    let warn: AimWarn | null = null;
    for (const i of able) {
      if (!allIn) plan.set(i, s.valid.get(i)!.find((t) => sameTarget(t, only))!);
      else if (s.must.has(i)) warn ??= { kind: "must", id: i };
      else plan.delete(i);
    }
    return result(s, { plan, waiting: s.waiting.filter((i) => !able.includes(i)), warn });
  }
  if (able.some((i) => s.waiting.includes(i))) {
    // Clicked again while waiting: put down, and out of the attack if it was in it.
    let warn: AimWarn | null = null;
    for (const i of able) {
      if (!plan.has(i)) continue;
      if (s.must.has(i)) warn ??= { kind: "must", id: i };
      else plan.delete(i);
    }
    return result(s, { plan, waiting: s.waiting.filter((i) => !able.includes(i)), warn });
  }
  return result(s, { waiting: [...s.waiting, ...able] });
}

/**
 * A click or tap on a player, planeswalker or battle. With creatures waiting, those that may
 * attack it do; with none, it becomes the one "A" sends everything at.
 */
export function pressDefender(s: AimState, t: AttackAt): AimResult {
  if (!s.waiting.length) {
    const anyCan = [...s.valid.values()].some((ts) => ts.some((x) => sameTarget(x, t)));
    return result(s, { defender: anyCan ? t : s.defender });
  }
  const legal = s.waiting.filter((i) => s.valid.get(i)?.some((x) => sameTarget(x, t)));
  // Not somewhere any of them may attack: it has no ring, so nothing happens.
  if (!legal.length) return result(s, {});
  // One that must attack someone it can attack goes nowhere else: the engine would refuse the
  // attack. It keeps waiting, and the red line says whom it must attack.
  const bound = (i: number) => (s.must.get(i) ?? []).filter((m) => s.valid.get(i)?.some((x) => sameTarget(x, m)));
  const held = legal.filter((i) => bound(i).length > 0 && !bound(i).some((m) => sameTarget(m, t)));
  const fits = legal.filter((i) => !held.includes(i));
  const plan = new Map(s.plan);
  for (const i of fits) plan.set(i, s.valid.get(i)!.find((x) => sameTarget(x, t))!);
  const rest = s.waiting.filter((i) => !fits.includes(i));
  const warn: AimWarn | null = held.length
    ? { kind: "mustAt", id: held[0]!, at: bound(held[0]!)[0]! }
    : rest.length
      ? { kind: "cant", id: rest[0]!, at: t }
      : null;
  return result(s, { plan, waiting: rest, defender: fits.length ? t : s.defender, warn });
}

/** Esc, or a click on empty table: the waiting creatures are put down where they were. */
export function cancelAim(s: AimState): AimResult {
  return result(s, { waiting: [] });
}
