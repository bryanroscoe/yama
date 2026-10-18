// Fake phone captures: put a card scan into a camera-sized frame near the on-screen guide, with
// a background, a small rotation and perspective skew, uneven light, blur, noise and JPEG.

import { applyH, rectQuad, squareToQuad } from "../image";
import type { Point, Quad, RgbaImage } from "../types";

export type Background = "felt" | "wood" | "desk" | "black";

export interface SceneParams {
  frameW: number;
  frameH: number;
  /** Guide width as a share of the frame width. */
  guideFill: number;
  /** Card offset from the guide centre, as a share of the guide width. */
  offset: number;
  /** Card size relative to the guide (1 = fits exactly). Picked in [scaleMin, scaleMax]. */
  scaleMin: number;
  scaleMax: number;
  /** Maximum rotation in degrees (random sign). */
  rotate: number;
  /** Extra rotation, e.g. 180 for an upside-down card. */
  turn?: number;
  /** Corner jitter for perspective, as a share of the card width. */
  perspective: number;
  brightness: number;
  /** Strength of a left-to-right lighting gradient (0 = flat). */
  shade: number;
  glare: boolean;
  blur: number; // gaussian sigma in px
  noise: number; // gaussian sigma in grey levels
  jpeg: number; // quality, 0 = no recompression
  background: Background;
}

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

export function guideQuad(p: Pick<SceneParams, "frameW" | "frameH" | "guideFill">): Quad {
  const w = p.frameW * p.guideFill;
  const h = (w * 88) / 63;
  return rectQuad((p.frameW - w) / 2, (p.frameH - h) / 2, w, h);
}

function background(kind: Background, w: number, h: number, rand: () => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const base: Record<Background, [number, number, number]> = {
    felt: [30, 62, 48],
    wood: [120, 82, 50],
    desk: [190, 188, 182],
    black: [22, 22, 24],
  };
  const [r0, g0, b0] = base[kind];
  const phase = rand() * 10;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let k = 1;
      if (kind === "wood") k = 0.85 + 0.15 * Math.sin(y / 9 + Math.sin(x / 140 + phase) * 3);
      if (kind === "felt") k = 0.92 + 0.08 * Math.sin(x / 3.1 + y / 2.3) * Math.sin(y / 5.7);
      const n = (rand() - 0.5) * 10;
      const o = (y * w + x) * 4;
      out[o] = r0 * k + n;
      out[o + 1] = g0 * k + n;
      out[o + 2] = b0 * k + n;
      out[o + 3] = 255;
    }
  }
  return out;
}

function gaussianBlur(img: RgbaImage, sigma: number) {
  if (sigma <= 0.05) return;
  const r = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i += 1) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i]! /= sum;
  const { width: w, height: h, data } = img;
  const tmp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let k = -r; k <= r; k += 1) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const o = (y * w + xx) * 4;
        const kw = kernel[k + r]!;
        a += data[o]! * kw;
        b += data[o + 1]! * kw;
        c += data[o + 2]! * kw;
      }
      const t = (y * w + x) * 3;
      tmp[t] = a;
      tmp[t + 1] = b;
      tmp[t + 2] = c;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let k = -r; k <= r; k += 1) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const t = (yy * w + x) * 3;
        const kw = kernel[k + r]!;
        a += tmp[t]! * kw;
        b += tmp[t + 1]! * kw;
        c += tmp[t + 2]! * kw;
      }
      const o = (y * w + x) * 4;
      data[o] = a;
      data[o + 1] = b;
      data[o + 2] = c;
    }
  }
}

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

export interface Scene {
  frame: RgbaImage;
  /** Where the card really is, printed order. */
  truth: Quad;
  guide: Quad;
}

/**
 * Render a scene. `encodeDecodeJpeg` round-trips the frame through JPEG at a quality (passed in
 * so this file stays free of Node-only imports).
 */
export function renderScene(
  card: RgbaImage,
  p: SceneParams,
  seed: number,
  encodeDecodeJpeg?: (img: RgbaImage, quality: number) => RgbaImage,
): Scene {
  const rand = rng(seed);
  const guide = guideQuad(p);
  const gw = p.frameW * p.guideFill;
  const gh = (gw * 88) / 63;
  const scale = p.scaleMin + (p.scaleMax - p.scaleMin) * rand();
  const angle = ((((rand() * 2 - 1) * p.rotate + (p.turn ?? 0)) * Math.PI) / 180);
  const cx = p.frameW / 2 + (rand() * 2 - 1) * p.offset * gw;
  const cy = p.frameH / 2 + (rand() * 2 - 1) * p.offset * gw;
  const hw = (gw * scale) / 2;
  const hh = (gh * scale) / 2;
  const corners: Point[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const truth = corners.map(([x, y]) => {
    const jx = (rand() * 2 - 1) * p.perspective * gw;
    const jy = (rand() * 2 - 1) * p.perspective * gw;
    return [cx + x * Math.cos(angle) - y * Math.sin(angle) + jx, cy + x * Math.sin(angle) + y * Math.cos(angle) + jy] as Point;
  }) as Quad;

  const data = background(p.background, p.frameW, p.frameH, rand);
  const frame: RgbaImage = { width: p.frameW, height: p.frameH, data };
  // Inverse map: frame pixel -> unit card coordinates.
  const inv = invert3(squareToQuad(truth));
  const xs = truth.map((q) => q[0]);
  const ys = truth.map((q) => q[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(p.frameW - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(p.frameH - 1, Math.ceil(Math.max(...ys)));
  const rx = 0.045; // corner radius as a share of width
  const ry = (rx * 63) / 88;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const [u, v] = applyH(inv, x + 0.5, y + 0.5);
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const du = u < rx ? rx - u : u > 1 - rx ? u - (1 - rx) : 0;
      const dv = v < ry ? ry - v : v > 1 - ry ? v - (1 - ry) : 0;
      if (du > 0 && dv > 0 && (du / rx) ** 2 + (dv / ry) ** 2 > 1) continue;
      const sx = u * card.width - 0.5;
      const sy = v * card.height - 0.5;
      const ix = Math.max(0, Math.min(card.width - 2, Math.floor(sx)));
      const iy = Math.max(0, Math.min(card.height - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - ix));
      const fy = Math.min(1, Math.max(0, sy - iy));
      const o = (y * p.frameW + x) * 4;
      for (let ch = 0; ch < 3; ch += 1) {
        const i00 = (iy * card.width + ix) * 4 + ch;
        const a = card.data[i00]!;
        const b = card.data[i00 + 4]!;
        const c = card.data[i00 + card.width * 4]!;
        const d = card.data[i00 + card.width * 4 + 4]!;
        data[o + ch] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
      }
    }
  }

  // Lighting: brightness, a gradient, an optional glare spot, then optics and sensor.
  const gx = rand() * p.frameW;
  const gy = rand() * p.frameH;
  const gr = p.frameW * 0.18;
  for (let y = 0; y < p.frameH; y += 1) {
    for (let x = 0; x < p.frameW; x += 1) {
      const o = (y * p.frameW + x) * 4;
      let k = p.brightness * (1 - p.shade / 2 + (p.shade * x) / p.frameW);
      let add = 0;
      if (p.glare) {
        const d2 = ((x - gx) ** 2 + (y - gy) ** 2) / (gr * gr);
        add = 150 * Math.exp(-d2);
      }
      for (let ch = 0; ch < 3; ch += 1) data[o + ch] = data[o + ch]! * k + add;
    }
  }
  gaussianBlur(frame, p.blur);
  if (p.noise > 0) {
    for (let i = 0; i < data.length; i += 4) {
      // Box-Muller
      const n = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand()) * p.noise;
      data[i] = data[i]! + n;
      data[i + 1] = data[i + 1]! + n;
      data[i + 2] = data[i + 2]! + n;
    }
  }
  const out = p.jpeg > 0 && encodeDecodeJpeg ? encodeDecodeJpeg(frame, p.jpeg) : frame;
  return { frame: out, truth, guide };
}

const BASE = { frameW: 1080, frameH: 1440, guideFill: 0.78, turn: 0 };

/** The capture conditions the eval runs every card through. */
export const VARIANTS: Record<string, SceneParams> = {
  steady: { ...BASE, offset: 0.01, scaleMin: 0.98, scaleMax: 1.01, rotate: 1, perspective: 0.005, brightness: 1, shade: 0.1, glare: false, blur: 0.6, noise: 3, jpeg: 90, background: "felt" },
  handheld: { ...BASE, offset: 0.03, scaleMin: 0.94, scaleMax: 1.03, rotate: 4, perspective: 0.02, brightness: 0.85, shade: 0.3, glare: false, blur: 1.2, noise: 5, jpeg: 75, background: "wood" },
  rough: { ...BASE, offset: 0.05, scaleMin: 0.92, scaleMax: 1.05, rotate: 6, perspective: 0.03, brightness: 0.65, shade: 0.4, glare: true, blur: 1.8, noise: 8, jpeg: 60, background: "black" },
  "far (720p-like)": { ...BASE, guideFill: 0.5, offset: 0.03, scaleMin: 0.94, scaleMax: 1.03, rotate: 4, perspective: 0.02, brightness: 0.85, shade: 0.3, glare: false, blur: 1.0, noise: 5, jpeg: 75, background: "desk" },
  "upside down": { ...BASE, turn: 180, offset: 0.03, scaleMin: 0.94, scaleMax: 1.03, rotate: 4, perspective: 0.02, brightness: 0.85, shade: 0.3, glare: false, blur: 1.2, noise: 5, jpeg: 75, background: "felt" },
};
