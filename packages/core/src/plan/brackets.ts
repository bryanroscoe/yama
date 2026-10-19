// Bracket builds: the after list with each bracket's bag of swaps applied, so basic land counts
// survive (commander-decks' brackets.py works on sets of names and loses them). Bags are
// cumulative: Bracket 2 is Bracket 3's list with the Bracket 2 bag applied on top.

import { BASICS } from "./text";
import type { Bag, Bracket, Slot } from "./types";

export interface BracketBuild {
  bracket: number;
  /** The swaps this step made on top of the previous build (none for the full build). */
  swaps: Bag[];
  cards: Slot[];
  /** Bag swaps that couldn't be applied, in words. */
  warnings: string[];
}

/** Apply one bag to a list. A swap whose `out` isn't in the list is skipped with a warning. */
export function applyBag(cards: Slot[], bag: Bag[], label: string): { cards: Slot[]; warnings: string[] } {
  const out = cards.map((c) => ({ ...c }));
  const warnings: string[] = [];
  const at = (name: string) => out.findIndex((c) => c.board === "main" && c.name === name);
  for (const b of bag) {
    const i = at(b.out);
    if (i < 0) {
      warnings.push(`${label}: ${b.out} isn't in the list, so ${b.in} wasn't swapped in.`);
      continue;
    }
    const j = at(b.in);
    if (j >= 0 && !BASICS.has(b.in)) {
      warnings.push(`${label}: ${b.in} is already in the list, so ${b.out} stays.`);
      continue;
    }
    const slot = out[i]!;
    if (slot.qty > 1) slot.qty -= 1;
    else out.splice(i, 1);
    const k = at(b.in);
    if (k >= 0) out[k]!.qty += 1;
    else out.push({ name: b.in, qty: 1, board: "main", kind: "bracket", replaces: b.out, got: b.got ?? null, source: b.from ?? null });
  }
  return { cards: out, warnings };
}

/**
 * The full build at the plan's target bracket (4 when it doesn't say), then one build per bag,
 * highest bracket first, each on top of the one before.
 */
export function bracketBuilds(after: Slot[], bracket: Bracket | null | undefined): BracketBuild[] {
  const builds: BracketBuild[] = [{ bracket: bracket?.target ?? 4, swaps: [], cards: after, warnings: [] }];
  const keys = Object.keys(bracket?.bags ?? {})
    .filter((k) => Number.isFinite(Number(k)))
    .sort((a, b) => Number(b) - Number(a));
  let cards = after;
  for (const k of keys) {
    const bag = bracket!.bags![k] ?? [];
    const r = applyBag(cards, bag, `Bracket ${k}`);
    cards = r.cards;
    builds.push({ bracket: Number(k), swaps: bag, cards, warnings: r.warnings });
  }
  return builds;
}

/** The Game Changers in a list, A to Z. */
export function gameChangersIn(cards: Slot[], names: Iterable<string>): string[] {
  const list = new Set(names);
  return [...new Set(cards.filter((c) => list.has(c.name)).map((c) => c.name))].sort();
}
