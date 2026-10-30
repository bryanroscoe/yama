// Bracket swap cards: one card-sized note per deck, kept in the deck box, saying which cards to swap
// to change bracket. The same cards commander-decks prints (scripts/shopping/swapcards.py,
// mtg-bracket-swap-cards.html), read from the plan's `bracket` objects.

import type { Bag, PlanBundle, PlanDeck } from "./types";

export interface SwapCardStep {
  /** The bracket this step starts from and the one it ends at ("Bracket 4 → 3"). */
  from: number;
  to: number;
  swaps: { out: string; in: string; outGc: boolean; inGc: boolean }[];
}

export interface SwapCard {
  key: string;
  name: string;
  /** Commander names joined with " & ", as the deck box shows them. */
  commander: string;
  /** The full build's bracket. */
  target: number;
  /** The bracket the deck sits at in its box: `bracket.box`, else the full build's. */
  box: number;
  /** Each step down, highest first. Steps with no swaps are left out. */
  steps: SwapCardStep[];
  /** Cards kept for Bracket 4 that are in no build (`bracket.extras`). */
  extras: { name: string; gc: boolean }[];
}

/** A plan deck's swap card, or null when its plan has no bracket. */
export function swapCard(deck: PlanDeck, gameChangers: Iterable<string> = []): SwapCard | null {
  const b = deck.bracket;
  if (!b) return null;
  const gc = new Set(gameChangers);
  // The deck's own per-bracket Game Changer lists (an export extra), so a card is marked even when
  // the plan-wide list is missing.
  for (const names of Object.values(b.game_changers ?? {})) for (const n of Array.isArray(names) ? names : []) gc.add(n);
  const target = b.target ?? 4;
  const steps: SwapCardStep[] = [];
  let from = target;
  const keys = Object.keys(b.bags ?? {})
    .map(Number)
    .filter((k) => Number.isInteger(k) && k < target)
    .sort((x, y) => y - x);
  for (const to of keys) {
    const bag: Bag[] = b.bags?.[String(to)] ?? [];
    if (bag.length) steps.push({ from, to, swaps: bag.map((s) => ({ out: s.out, in: s.in, outGc: gc.has(s.out), inGc: gc.has(s.in) })) });
    from = to;
  }
  return {
    key: deck.key,
    name: deck.name,
    commander: deck.commander.join(" & "),
    target,
    box: typeof b.box === "number" ? b.box : target,
    steps,
    extras: (b.extras ?? []).filter((n) => typeof n === "string" && n.trim()).map((name) => ({ name, gc: gc.has(name) })),
  };
}

/** Every active plan deck's swap card, in plan order; decks without a bracket plan are skipped. */
export function swapCards(b: Pick<PlanBundle, "decks" | "game_changers">): SwapCard[] {
  const gc = b.game_changers?.names ?? [];
  return b.decks
    .filter((d) => d.status === "active")
    .map((d) => swapCard(d, gc))
    .filter((c): c is SwapCard => c !== null);
}

/** Split cards into printed pages, nine to a US-letter page (three by three). */
export function swapCardPages<T>(cards: T[], perPage = 9): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < cards.length; i += perPage) pages.push(cards.slice(i, i + perPage));
  return pages;
}
