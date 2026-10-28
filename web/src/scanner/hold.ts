// After a card found by its text is added, the scanner holds that card: reads of it are ignored
// until it has clearly left. Text reads are noisy and alternate orientations (so some reads of a
// card still in view see nothing), so one misread or a few empty reads aren't proof it left; that
// would add a stationary card again.

export interface Hold {
  name: string;
  /** When the held card was last read. */
  lastSeen: number;
  /** Reads in a row that saw no card. */
  misses: number;
  /** Another card read while held, and how many times since the held card was last read. */
  other?: string;
  seenOther: number;
}

export const hold = (name: string, now = Date.now()): Hold => ({ name, lastSeen: now, misses: 0, seenOther: 0 });

/** Empty reads that end a hold (text-only mode), and for how long the held card must be unseen. */
export const EMPTY_READS = 4;
export const UNSEEN_MS = 3000;

/**
 * What one read means while a card is held: "held" (ignore it) or "free" (the hold is over;
 * handle the read). Another card frees it when read twice (empty reads between don't count
 * against it) or once near-certainly. Empty reads free it only when `emptyFrees` (text-only
 * mode; with the card detector, its seeing no card ends the hold instead), after EMPTY_READS in a
 * row and UNSEEN_MS without the held card. Updates `h`.
 */
export function holdRead(h: Hold, best: { name: string; confidence: number } | undefined, now: number, emptyFrees: boolean): "held" | "free" {
  if (best?.name === h.name) {
    h.lastSeen = now;
    h.misses = 0;
    h.other = undefined;
    h.seenOther = 0;
    return "held";
  }
  if (!best) {
    h.misses += 1;
    return emptyFrees && h.misses >= EMPTY_READS && now - h.lastSeen >= UNSEEN_MS ? "free" : "held";
  }
  h.misses = 0;
  h.seenOther = h.other === best.name ? h.seenOther + 1 : 1;
  h.other = best.name;
  return best.confidence >= 0.95 || h.seenOther >= 2 ? "free" : "held";
}
