// What the placement gate (gate.ts) needs from a frame's pixels, for a camera whose frames the
// scanner can see (the browser's): how sharp the card is in this frame, and a small grey thumbnail
// of it. Pure pixel arithmetic; the native camera works these out itself.

import { halve, laplacianVariance } from "./quality";
import { THUMB_SIDE } from "./gate";
import type { Gray, Quad, RgbaImage } from "./types";

/**
 * The card warped upright to `w` × `h` grey, bilinear between the frame's pixels and across the
 * quad's corners. `inset` leaves that share of the card out at each edge.
 */
export function warpCard(frame: RgbaImage, quad: Quad, w: number, h: number, inset = 0): Gray {
  const [a, b, c, d] = quad;
  const out = new Uint8ClampedArray(w * h);
  const { width, height, data } = frame;
  for (let j = 0; j < h; j += 1) {
    const v = inset + ((1 - 2 * inset) * (j + 0.5)) / h;
    for (let i = 0; i < w; i += 1) {
      const u = inset + ((1 - 2 * inset) * (i + 0.5)) / w;
      const x = Math.min(width - 1, Math.max(0, (1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0])));
      const y = Math.min(height - 1, Math.max(0, (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1])));
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const tx = x - x0;
      const ty = y - y0;
      const lumAt = (px: number, py: number) => {
        const k = (py * width + px) * 4;
        return 0.299 * data[k]! + 0.587 * data[k + 1]! + 0.114 * data[k + 2]!;
      };
      const top = lumAt(x0, y0) + (lumAt(x1, y0) - lumAt(x0, y0)) * tx;
      const bottom = lumAt(x0, y1) + (lumAt(x1, y1) - lumAt(x0, y1)) * tx;
      out[j * w + i] = top + (bottom - top) * ty;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * The thumbnail leaves the card's border and frame edge out: every card has them, and they would
 * make any two cards look alike.
 */
const THUMB_INSET = 0.09;

/** The size the card is warped to before its sharpness is measured (then halved, against sensor noise). */
const SHARP_W = 192;
const SHARP_H = 268;

/**
 * How sharp the card is in this frame: the variance of the Laplacian (quality.ts) over the whole
 * card at a fixed size, so frames of one placement compare. Higher is sharper; the number means
 * nothing across cameras or card sizes.
 */
export function frameSharpness(frame: RgbaImage, quad: Quad): number {
  return laplacianVariance(halve(warpCard(frame, quad, SHARP_W, SHARP_H)));
}

/**
 * The card as a THUMB_SIDE × THUMB_SIDE grey thumbnail (each pixel the mean of a 2 × 2 block), for
 * telling "the same card, nudged" from "another card" (gate.ts, `thumbLikeness`). The card's top
 * goes where the quad's first corner is. Two different cards still look somewhat alike at this
 * size (art above, text below: about 0.5 to 0.7 on drawn cards), which is why the gate asks for
 * 0.85; the same card nudged, dimmer and smaller measures about 0.95.
 */
export function cardThumb(frame: RgbaImage, quad: Quad): Uint8Array {
  return new Uint8Array(halve(warpCard(frame, quad, THUMB_SIDE * 2, THUMB_SIDE * 2, THUMB_INSET)).data);
}
