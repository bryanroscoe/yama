// Sample hands for a deck: shuffle the library (commanders stay in the command zone), draw 7,
// mulligan (the London mulligan; the first one is free in Commander multiplayer), draw on.

export interface LibraryCard {
  id: string;
  name: string;
}

/** Small seeded generator (mulberry32) so a hand can be reproduced from its seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface Goldfish {
  library: LibraryCard[];
  hand: LibraryCard[];
  mulligans: number;
  /** Cards to put on the bottom after a mulligan (London: one per mulligan, minus the free one). */
  toBottom: number;
  drawn: number;
}

export function newHand(cards: LibraryCard[], random: () => number, mulligans = 0, freeMulligan = true): Goldfish {
  const library = shuffle(cards, random);
  const hand = library.slice(0, 7);
  return {
    library: library.slice(7),
    hand,
    mulligans,
    toBottom: Math.max(0, mulligans - (freeMulligan ? 1 : 0)),
    drawn: 0,
  };
}

export function draw(g: Goldfish): Goldfish {
  const [top, ...rest] = g.library;
  if (!top) return g;
  return { ...g, library: rest, hand: [...g.hand, top], drawn: g.drawn + 1 };
}

export function bottom(g: Goldfish, index: number): Goldfish {
  const card = g.hand[index];
  if (!card || g.toBottom === 0) return g;
  return { ...g, hand: g.hand.filter((_, i) => i !== index), library: [...g.library, card], toBottom: g.toBottom - 1 };
}

/** Expand a deck list into individual library cards (basics appear as many times as listed). */
export function expandDeck(cards: { oracle_id: string; name: string; qty: number; board: string }[]): LibraryCard[] {
  return cards
    .filter((c) => c.board === "main")
    .flatMap((c) => Array.from({ length: c.qty }, (_, i) => ({ id: `${c.oracle_id}:${i}`, name: c.name })));
}
