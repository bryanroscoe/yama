// Drawn camera frames for the app's parity checks (finderDevice.test.ts, artDevice.test.ts): a
// card picture laid on a table, turned about its centre and sampled bilinearly, at the size of the
// frame the web recognizer reads. Not part of the app.

import { seeded } from "./syntheticCards";
import type { Quad, RgbaImage } from "../types";

export const W = 640;
export const H = 1138;

/** A card on the frame: which, where its centre is, its width in pixels, its turn in degrees. */
export interface Placed {
  card: RgbaImage;
  cx: number;
  cy: number;
  width: number;
  angle: number;
}

/** A table: a soft gradient with grain. */
function table(seed: number): Uint8ClampedArray {
  const rand = seeded(seed);
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const g = 70 + (40 * y) / H + (20 * x) / W + (rand() - 0.5) * 14;
      d[o] = g * 0.9;
      d[o + 1] = g;
      d[o + 2] = g * 1.08;
      d[o + 3] = 255;
    }
  }
  return d;
}

/** The frame with the card drawn on it, turned about its centre, sampled bilinearly. */
export function scene(p: Placed | null, seed: number): RgbaImage {
  const data = table(seed);
  if (p) {
    const { card } = p;
    const k = p.width / card.width;
    const a = (p.angle * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const half = Math.hypot(card.width, card.height) * k * 0.5 + 2;
    for (let y = Math.max(0, Math.floor(p.cy - half)); y < Math.min(H, Math.ceil(p.cy + half)); y++) {
      for (let x = Math.max(0, Math.floor(p.cx - half)); x < Math.min(W, Math.ceil(p.cx + half)); x++) {
        const dx = x - p.cx;
        const dy = y - p.cy;
        const u = (c * dx + s * dy) / k + card.width / 2;
        const v = (-s * dx + c * dy) / k + card.height / 2;
        if (u < 0 || v < 0 || u > card.width - 1 || v > card.height - 1) continue;
        const u0 = Math.floor(u);
        const v0 = Math.floor(v);
        const tu = u - u0;
        const tv = v - v0;
        const u1 = Math.min(card.width - 1, u0 + 1);
        const v1 = Math.min(card.height - 1, v0 + 1);
        const o = (y * W + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const at = (uu: number, vv: number) => card.data[(vv * card.width + uu) * 4 + ch]!;
          const top = at(u0, v0) + (at(u1, v0) - at(u0, v0)) * tu;
          const bottom = at(u0, v1) + (at(u1, v1) - at(u0, v1)) * tu;
          data[o + ch] = top + (bottom - top) * tv;
        }
      }
    }
  }
  return { width: W, height: H, data };
}


/** The card's corners on the frame, top-left as printed first, clockwise. */
export function placedQuad(p: Placed): Quad {
  const k = p.width / p.card.width;
  const a = (p.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hw = (p.card.width / 2) * k;
  const hh = (p.card.height / 2) * k;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => [p.cx + c * x! - s * y!, p.cy + s * x! + c * y!]) as Quad;
}
