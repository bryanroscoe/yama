// The change "Try a change" plays: a list of swaps, each a card out and a card in. A swap may be
// one-sided (a plain cut, or a plain add). The server takes adds and cuts (one name per copy), so
// the pairs are only for showing what replaces what.

import { identityKeys } from "@yama/core";
import { tally, type BaseLine } from "./logic";

/** What the page knows about a card going in, from the search or the plan. */
export interface InCard {
  type_line?: string | null;
  color_identity?: string | null;
  image_small?: string | null;
  mana_cost?: string | null;
  cmc?: number | null;
}

export interface Swap {
  /** Stable key for the row. */
  id: string;
  /** The card taken out of the base's main deck (one copy); null for a plain add. */
  out: string | null;
  /** The card put in (one copy); null for a plain cut. */
  in: string | null;
  inCard?: InCard;
  /** Where the idea came from, shown under the row ("From your plan", "Proposed in your plan"). */
  note?: string;
}

let next = 0;
/** A new swap row. */
export function swap(out: string | null, inName: string | null, extra: Pick<Swap, "inCard" | "note"> = {}): Swap {
  next += 1;
  return { id: `s${Date.now().toString(36)}${next}`, out, in: inName, ...extra };
}

/** The adds and cuts the server takes, one name per copy. */
export function addsAndCuts(swaps: Swap[]): { add: string[]; cut: string[] } {
  return {
    add: swaps.flatMap((s) => (s.in ? [s.in] : [])),
    cut: swaps.flatMap((s) => (s.out ? [s.out] : [])),
  };
}

/**
 * Swaps for adds and cuts that came without pairs (Try again, a plan's lists): `pairs` (out, in)
 * matched first, then the rest paired in order, then the leftovers one-sided.
 */
export function swapsFrom(add: string[], cut: string[], pairs: [string, string][] = []): Swap[] {
  const adds = [...add];
  const cuts = [...cut];
  const out: Swap[] = [];
  const take = (list: string[], name: string) => {
    const i = list.indexOf(name);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  };
  for (const [o, i] of pairs) {
    if (cuts.includes(o) && adds.includes(i)) {
      take(cuts, o);
      take(adds, i);
      out.push(swap(o, i));
    }
  }
  while (cuts.length && adds.length) out.push(swap(cuts.shift()!, adds.shift()!));
  for (const c of cuts) out.push(swap(c, null));
  for (const a of adds) out.push(swap(null, a));
  return out;
}

/** The changed list's size: the base, less the cuts, plus the adds. */
export function swapCount(base: BaseLine[], swaps: Swap[]): number {
  const played = base.filter((l) => l.board !== "side").reduce((n, l) => n + l.qty, 0);
  return played - swaps.filter((s) => s.out).length + swaps.filter((s) => s.in).length;
}

/** Copies of `name` in the base's main deck not cut yet. */
export function stillIn(base: BaseLine[], swaps: Swap[], name: string): number {
  const have = base.filter((l) => l.board === "main" && l.name === name).reduce((n, l) => n + l.qty, 0);
  return have - swaps.filter((s) => s.out === name).length;
}

const isBasic = (type: string | null | undefined, name: string) =>
  (type ?? "").includes("Basic") || ["Wastes", "Plains", "Island", "Swamp", "Mountain", "Forest"].includes(name);

/** Cards Commander lets a deck run any number of (their text says so). */
const ANY_NUMBER = new Set([
  "Relentless Rats",
  "Rat Colony",
  "Shadowborn Apostle",
  "Persistent Petitioners",
  "Dragon's Approach",
  "Seven Dwarves",
  "Slime Against Humanity",
  "Hare Apparent",
  "Templar Knight",
  "Tempest Hawk",
  "Cid, Timeless Artificer",
  "Nazgûl",
]);

/**
 * What's wrong with the changed list, in plain words: the count (a game needs exactly 100), cards
 * outside the commander's colours, and second copies of a card that isn't a basic land. Only the
 * count stops a run; the server plays the rest anyway and says so.
 */
export function changeProblems(base: BaseLine[], swaps: Swap[], identity: string | null): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const count = swapCount(base, swaps);
  if (count !== 100) blocking.push(`The changed list has ${count} cards; a game needs exactly 100. ${count < 100 ? `Add ${100 - count}` : `Cut ${count - 100}`} to even it out.`);
  if (identity != null) {
    const allowed = new Set(identityKeys(identity).filter((k) => k !== "C"));
    for (const s of swaps) {
      const ci = s.in ? s.inCard?.color_identity : null;
      if (!s.in || ci == null) continue;
      const outside = identityKeys(ci).filter((k) => k !== "C" && !allowed.has(k));
      if (outside.length) warnings.push(`${s.in} is outside the commander's colors.`);
    }
  }
  const adds = tally(swaps.flatMap((s) => (s.in ? [s.in] : [])));
  for (const [name, n] of adds) {
    const type = swaps.find((s) => s.in === name)?.inCard?.type_line ?? null;
    if (isBasic(type, name) || ANY_NUMBER.has(name)) continue;
    const kept = base.filter((l) => l.board !== "side" && l.name === name).reduce((k, l) => k + l.qty, 0) - swaps.filter((s) => s.out === name).length;
    if (kept + n > 1) warnings.push(`${name} would be in the list ${kept + n} times; Commander allows one copy.`);
  }
  return { blocking, warnings: [...new Set(warnings)] };
}

/** The change in words: "Darkness → Toxic Deluge, −Ponder, +Sol Ring". */
export function swapText(swaps: Swap[]): string {
  return swaps
    .map((s) => (s.out && s.in ? `${s.out} → ${s.in}` : s.out ? `−${s.out}` : s.in ? `+${s.in}` : ""))
    .filter(Boolean)
    .join(", ");
}

/**
 * Turn one list into another as swaps: cards only in `to` pair with cards only in `from`, using
 * `pairs` (out, in) where they match (a plan's swaps), the rest in order.
 */
export function listDiff(from: BaseLine[], to: BaseLine[], pairs: [string, string][] = []): Swap[] {
  const count = (lines: BaseLine[]) => {
    const m = new Map<string, number>();
    for (const l of lines) if (l.board === "main") m.set(l.name, (m.get(l.name) ?? 0) + l.qty);
    return m;
  };
  const a = count(from);
  const b = count(to);
  const add: string[] = [];
  const cut: string[] = [];
  for (const [name, n] of b) for (let i = 0; i < n - (a.get(name) ?? 0); i++) add.push(name);
  for (const [name, n] of a) for (let i = 0; i < n - (b.get(name) ?? 0); i++) cut.push(name);
  return swapsFrom(add, cut, pairs);
}
