// Finding the held card again, frame by frame, when it wasn't recognised by its art (a typed name,
// or a card read from its text): the hold-and-read loop can't ask "is the best art match still
// this card?", so it goes by where the card is (Bryan, 15 Nov 2026: read the printing of a typed
// card from the live camera, as for one found by its art). The detector's outline is the card's
// even when its art match is weak. A card that jumps to another place or size is taken to be
// another card, so it can never settle this one's printing.

import type { Quad } from "./types";

const centre = (q: Quad): [number, number] => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];

/** Area by the shoelace formula. */
export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i += 1) {
    const [x0, y0] = q[i]!;
    const [x1, y1] = q[(i + 1) % 4]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * Of the cards in view, the one being held out: the largest, less the further it is from the
 * middle of the frame (a card at the edge counts for up to half its size).
 */
export function pickHeldQuad(quads: readonly Quad[], width: number, height: number): Quad | null {
  let best: Quad | null = null;
  let bestScore = -Infinity;
  const half = Math.hypot(width, height) / 2 || 1;
  for (const q of quads) {
    const [cx, cy] = centre(q);
    const off = Math.min(1, Math.hypot(cx - width / 2, cy - height / 2) / half);
    const score = quadArea(q) * (1 - off / 2);
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best;
}

/** How far the card may move between frames, as a share of its diagonal, and how much its size may change. */
export const MOVE_LIMIT = 0.35;
export const SIZE_LIMIT = 0.4;

/**
 * Whether `next` is still the card that was at `prev`: its middle moved less than MOVE_LIMIT of
 * the card's diagonal and its area changed by less than SIZE_LIMIT. A hand-held card drifts; a
 * card swapped in, or another card picked up, jumps.
 */
export function sameHeldCard(prev: Quad, next: Quad): boolean {
  const [px, py] = centre(prev);
  const [nx, ny] = centre(next);
  const diag = Math.max(Math.hypot(prev[2][0] - prev[0][0], prev[2][1] - prev[0][1]), Math.hypot(prev[3][0] - prev[1][0], prev[3][1] - prev[1][1]), 1);
  const a = quadArea(prev);
  const b = quadArea(next);
  const grew = Math.max(a, b) / Math.max(1, Math.min(a, b)) - 1;
  return Math.hypot(nx - px, ny - py) / diag < MOVE_LIMIT && grew < SIZE_LIMIT;
}
