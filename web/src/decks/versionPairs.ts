// A saved list's changes from the list before it, as pairs: the card that came in and the one it
// replaced (deck page SPEC 0b, History: "each change as a pair"). Versions store cards, not swaps,
// so the pairing is a reading: within a board, cards in and out pair up in name order, and what's
// left over stands alone (a card added with nothing taken out, or one taken out with nothing added).

import type { DeckCard } from "../api";

export interface PairCard {
  name: string;
  oracle_id: string;
}

export interface VersionPair {
  in: PairCard | null;
  out: PairCard | null;
  /** Copies: a land count going from 10 to 12 Plains, 12 to 10 Islands is one pair of 2. */
  qty: number;
}

const BOARDS = ["commander", "main", "side"] as const;

export function versionPairs(before: DeckCard[], after: DeckCard[]): VersionPair[] {
  const pairs: VersionPair[] = [];
  for (const board of BOARDS) {
    const count = (cards: DeckCard[]) => {
      const m = new Map<string, { card: PairCard; qty: number }>();
      for (const c of cards) {
        if ((c.board ?? "main") !== board) continue;
        const e = m.get(c.oracle_id) ?? { card: { name: c.name, oracle_id: c.oracle_id }, qty: 0 };
        e.qty += c.qty;
        m.set(c.oracle_id, e);
      }
      return m;
    };
    const a = count(before);
    const b = count(after);
    const delta = (from: typeof a, to: typeof a) =>
      [...to.values()]
        .map((e) => ({ card: e.card, qty: e.qty - (from.get(e.card.oracle_id)?.qty ?? 0) }))
        .filter((e) => e.qty > 0)
        .sort((x, y) => x.card.name.localeCompare(y.card.name));
    const ins = delta(a, b);
    const outs = delta(b, a);
    let i = 0;
    let o = 0;
    while (i < ins.length && o < outs.length) {
      const n = Math.min(ins[i]!.qty, outs[o]!.qty);
      pairs.push({ in: ins[i]!.card, out: outs[o]!.card, qty: n });
      ins[i]!.qty -= n;
      outs[o]!.qty -= n;
      if (!ins[i]!.qty) i++;
      if (!outs[o]!.qty) o++;
    }
    for (; i < ins.length; i++) pairs.push({ in: ins[i]!.card, out: null, qty: ins[i]!.qty });
    for (; o < outs.length; o++) pairs.push({ in: null, out: outs[o]!.card, qty: outs[o]!.qty });
  }
  return pairs;
}

/** Each version's list to compare with: the newest earlier one that was the deck's list (a scan
 *  saved only for History never was). Versions come newest first; the oldest has none. */
export function baseOf<V extends { id: string; history_only?: boolean }>(versions: V[], id: string): V | null {
  const i = versions.findIndex((v) => v.id === id);
  if (i < 0) return null;
  return versions.slice(i + 1).find((v) => !v.history_only) ?? null;
}
