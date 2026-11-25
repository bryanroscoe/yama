// Is a frame worth reading? (Bryan, 15 Nov 2026, from the scanner consult: skip blurred or
// glare-clipped frames before OCR, so they don't use up the reading budget.) Measured on the
// collector strip only, cut small: the variance of its Laplacian (how sharp its edges are) and the
// share of its pixels clipped to white (glare from a light or the flash on a foil or sleeve).

import { warpRegion, type CardRegion } from "./image";
import type { Gray, Quad } from "./types";

/** The strip measured: the corner the collector line is read from. */
const STRIP: CardRegion = { x0: 0.03, y0: 0.9, x1: 0.5, y1: 0.99 };
const STRIP_W = 320;
const STRIP_H = Math.round((STRIP_W * ((STRIP.y1 - STRIP.y0) * 88)) / ((STRIP.x1 - STRIP.x0) * 63));

export interface StripQuality {
  /** Variance of the 4-neighbour Laplacian over the strip (sharp print: hundreds; blur: tens). */
  sharpness: number;
  /** Share of the strip's pixels at 250 or more. */
  clipped: number;
  /** The card's height in the pixels the strip was measured from (sharpness depends on it: `sharpEnough`). */
  cardPx?: number;
}

/**
 * Below the bar (`sharpEnough`), or with more than CLIP_MAX of the strip clipped, a frame isn't
 * read. The strip is measured at one size whatever the card's, so the same print scores lower from
 * a smaller card (cut up to that size, its edges soften): the bar depends on the card's height in
 * the pixels it was measured from.
 *
 * - SHARP_MIN, for a card 900 px tall (SMALL_CARD_PX) or less, is from synthetic frames of 15 cards
 *   900 px tall (eval/quality.test.ts, [ran]): every frame that read scored 70 or more, frames too
 *   blurred to read 56 to 84; so 65 skips only frames that wouldn't have read there.
 * - SHARP_MIN_FULL, for a card 1800 px tall (FULL_CARD_PX) or more, is from Bryan's own frames
 *   (Bryan, 25 Nov 2026: "we still struggle to quickly find a high-quality version of the card
 *   number... I'm guessing it's a focusing issue"): of the 161 frames his Pixel read the line of in
 *   Scanner diagnostics from 22 to 25 Nov 2026, cards 1871 to 2589 px tall (10th to 90th
 *   percentile), none under 150 read the number (0 of 30), each still costing its crops' reads
 *   (about 0.7 s); 150 to 400 read it on 20 of 47, 400 and up on 61 of 84 [ran].
 * - Between the two, the bar runs straight from one to the other.
 *
 * CLIP_MAX is a guess [inferred].
 */
export const SHARP_MIN = 65;
export const SHARP_MIN_FULL = 150;
export const SMALL_CARD_PX = 900;
export const FULL_CARD_PX = 1800;
export const CLIP_MAX = 0.2;

export function stripQuality(gray: Gray, quad: Quad): StripQuality {
  // Cut at twice the size and average 2 × 2, so sensor noise doesn't pass for sharp edges.
  const g = halve(warpRegion(gray, quad, STRIP, STRIP_W * 2, STRIP_H * 2));
  return { sharpness: laplacianVariance(g), clipped: clippedShare(g), cardPx: heightOf(quad) };
}

/** The card's height in pixels, the mean of its left and right edges (closer.ts's `cardHeight`, which imports what imports this). */
const heightOf = (q: Quad) => (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;

/** The sharpness a strip needs to be read, for a card `cardPx` tall where it was measured (unknown: the small card's bar). */
export function sharpEnough(cardPx: number | undefined): number {
  if (cardPx == null || !(cardPx > SMALL_CARD_PX)) return SHARP_MIN;
  if (cardPx >= FULL_CARD_PX) return SHARP_MIN_FULL;
  return SHARP_MIN + ((SHARP_MIN_FULL - SHARP_MIN) * (cardPx - SMALL_CARD_PX)) / (FULL_CARD_PX - SMALL_CARD_PX);
}

/** Half the size, each pixel the mean of a 2 × 2 block. */
export function halve(g: Gray): Gray {
  const w = Math.floor(g.width / 2);
  const h = Math.floor(g.height / 2);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = 2 * y * g.width + 2 * x;
      out[y * w + x] = (g.data[i]! + g.data[i + 1]! + g.data[i + g.width]! + g.data[i + g.width + 1]! + 2) >> 2;
    }
  return { width: w, height: h, data: out };
}

export function laplacianVariance(g: Gray): number {
  const { width: w, height: h, data } = g;
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const l = data[i - 1]! + data[i + 1]! + data[i - w]! + data[i + w]! - 4 * data[i]!;
      sum += l;
      sq += l * l;
      n += 1;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sq / n - mean * mean;
}

export function clippedShare(g: Gray): number {
  let c = 0;
  for (let i = 0; i < g.data.length; i += 1) if (g.data[i]! >= 250) c += 1;
  return g.data.length ? c / g.data.length : 0;
}

export const worthReading = (q: StripQuality) => q.sharpness >= sharpEnough(q.cardPx) && q.clipped <= CLIP_MAX;
