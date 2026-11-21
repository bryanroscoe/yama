// A saved version's changes from the one before it: the cards that came in and the cards that
// went out (deck page SPEC 0b, History). Versions store cards, not swaps, so nothing says which
// card replaced which. Only a board's lone swap (one card in, one card out) is read as a pair,
// "X replaces Y"; anything more is listed as cards in and cards out. Pairing those up in name
// order stated swaps nobody made (a land "replacing" an artifact).

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
    if (ins.length === 1 && outs.length === 1) {
      // One card for one card is a swap; uneven copies leave the rest standing alone.
      const n = Math.min(ins[0]!.qty, outs[0]!.qty);
      pairs.push({ in: ins[0]!.card, out: outs[0]!.card, qty: n });
      ins[0]!.qty -= n;
      outs[0]!.qty -= n;
    }
    for (const e of ins) if (e.qty) pairs.push({ in: e.card, out: null, qty: e.qty });
    for (const e of outs) if (e.qty) pairs.push({ in: null, out: e.card, qty: e.qty });
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
