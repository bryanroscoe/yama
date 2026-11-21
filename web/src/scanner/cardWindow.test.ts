// The embed graph is given only the card's box of the frame (cardWindow): the card it warps out must
// come out the same as from the whole frame.

import { describe, expect, it } from "vitest";
import { cardWindow } from "./recognizer";
import type { Quad, RgbaImage } from "./types";

function noise(w: number, h: number, seed = 11): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) data[i] = (s = (s * 1103515245 + 12345) % 2147483648) % 256;
  return { width: w, height: h, data };
}

/** Bilinear sample of channel `ch` at (x, y), zero past the edges: the embed graph's GridSample (align_corners, zeros). */
function sample(img: RgbaImage, x: number, y: number, ch: number): number {
  const at = (px: number, py: number) => (px < 0 || py < 0 || px >= img.width || py >= img.height ? 0 : img.data[(py * img.width + px) * 4 + ch]!);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** Points across the quad, edges included, as the warp samples it. */
function across(q: Quad): [number, number][] {
  const out: [number, number][] = [];
  for (let j = 0; j <= 20; j++) {
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      const v = j / 20;
      const [a, b, c, d] = q;
      out.push([(1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]), (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1])]);
    }
  }
  return out;
}

describe("cardWindow", () => {
  const frame = noise(640, 1138);

  it("samples the card exactly as the whole frame does, from a third of the pixels", () => {
    const quad: Quad = [[143.6, 301.2], [497.9, 288.4], [512.3, 790.8], [131.1, 805.5]];
    const w = cardWindow(frame, quad);
    expect(w.frame.width * w.frame.height).toBeLessThan(0.4 * frame.width * frame.height);
    for (const [[x, y], [cx, cy]] of across(quad).map((p, i) => [p, across(w.quad)[i]!] as const)) {
      for (let ch = 0; ch < 3; ch++) expect(sample(w.frame, cx, cy, ch)).toBeCloseTo(sample(frame, x, y, ch), 6);
    }
  });

  it("stops at the frame's edge, so a card partly out of view pads the same way", () => {
    const quad: Quad = [[-40.5, -12], [300, -30.2], [320.4, 420], [-55, 440.7]];
    const w = cardWindow(frame, quad);
    expect(w.quad[0]).toEqual([-40.5, -12]);
    for (const [[x, y], [cx, cy]] of across(quad).map((p, i) => [p, across(w.quad)[i]!] as const)) {
      expect(sample(w.frame, cx, cy, 1)).toBeCloseTo(sample(frame, x, y, 1), 6);
    }
  });

  it("keeps the frame when the box would be all of it, or the quad isn't a place", () => {
    const all: Quad = [[0, 0], [640, 0], [640, 1138], [0, 1138]];
    expect(cardWindow(frame, all).frame).toBe(frame);
    const lost: Quad = [[NaN, 0], [10, 0], [10, 10], [0, 10]];
    expect(cardWindow(frame, lost).frame).toBe(frame);
    const off: Quad = [[-500, -500], [-400, -500], [-400, -300], [-500, -300]];
    expect(cardWindow(frame, off).frame).toBe(frame);
  });
});
