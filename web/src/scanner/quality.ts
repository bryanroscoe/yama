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
}

/**
 * Below SHARP_MIN, or with more than CLIP_MAX of the strip clipped, a frame isn't read. SHARP_MIN
 * is from synthetic frames of 15 cards 900 px tall (eval/quality.test.ts, [ran]): every frame
 * that read scored 70 or more, frames too blurred to read 56 to 84; so 65 skips only frames that
 * wouldn't have read there, and lets borderline ones through. CLIP_MAX is a guess. Both are to be
 * retuned on real frames [inferred].
 */
export const SHARP_MIN = 65;
export const CLIP_MAX = 0.2;

export function stripQuality(gray: Gray, quad: Quad): StripQuality {
  // Cut at twice the size and average 2 × 2, so sensor noise doesn't pass for sharp edges.
  const g = halve(warpRegion(gray, quad, STRIP, STRIP_W * 2, STRIP_H * 2));
  return { sharpness: laplacianVariance(g), clipped: clippedShare(g) };
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

export const worthReading = (q: StripQuality) => q.sharpness >= SHARP_MIN && q.clipped <= CLIP_MAX;
