// After a card found by its text is added, the scanner holds that card: reads of it are ignored
// until it has clearly left. Text reads are noisy, so one misread of another card, or one read
// that saw nothing, isn't proof the card left (that would add a stationary card again).

export interface Hold {
  name: string;
  /** Reads in a row that saw no card. */
  misses: number;
  /** Another card read while held, and how many reads in a row saw it. */
  other?: string;
  seenOther: number;
}

export const hold = (name: string): Hold => ({ name, misses: 0, seenOther: 0 });

/**
 * What one read means while a card is held: "held" (ignore it) or "free" (the hold is over;
 * handle the read). Free after three reads in a row see no card, or when another card is read
 * near-certainly once or twice in a row. Updates `h`.
 */
export function holdRead(h: Hold, best: { name: string; confidence: number } | undefined): "held" | "free" {
  if (best?.name === h.name) {
    h.misses = 0;
    h.other = undefined;
    h.seenOther = 0;
    return "held";
  }
  if (!best) {
    h.other = undefined;
    h.seenOther = 0;
    return ++h.misses >= 3 ? "free" : "held";
  }
  h.misses = 0;
  h.seenOther = h.other === best.name ? h.seenOther + 1 : 1;
  h.other = best.name;
  return best.confidence >= 0.95 || h.seenOther >= 2 ? "free" : "held";
}
