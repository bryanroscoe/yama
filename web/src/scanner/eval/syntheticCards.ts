// Drawn test cards for cardBack.test.ts and the recognizer's tests: a card back and card fronts made
// from flat shapes in the real ones' proportions and colours (measured, kept as numbers). No card
// image is in the repository, so these stand in for them. Not part of the app.

import type { RgbaImage } from "../types";

type Rgb = [number, number, number];

/** A small seeded generator, so every run draws the same card. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export interface Light {
  /** Gains on red, green and blue (the light's colour, or the camera's white balance). */
  gain?: Rgb;
  brightness?: number;
  /** Sensor noise: each channel moved by up to this, evenly. */
  noise?: number;
}

function paint(w: number, h: number, colourAt: (u: number, v: number, rand: () => number) => Rgb, light: Light, seed: number): RgbaImage {
  const rand = seeded(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  const gain = light.gain ?? [1, 1, 1];
  const bright = light.brightness ?? 1;
  const noise = light.noise ?? 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const c = colourAt((x + 0.5) / w, (y + 0.5) / h, rand);
      const k = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch += 1) data[k + ch] = c[ch]! * gain[ch]! * bright + (rand() * 2 - 1) * noise;
      data[k + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** A steady value from 0 to 1 for a grid cell. */
const cellNoise = (i: number, j: number): number => {
  const h = Math.imul(i * 374761393 + j * 668265263, 1274126177) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

const mottle = (c: Rgb, rand: () => number, by: number): Rgb => {
  const m = 1 + (rand() * 2 - 1) * by;
  return [c[0] * m, c[1] * m, c[2] * m];
};

/**
 * A standard card back: black border, olive-brown frame (darker on the left), the orange-brown
 * oval with its blue rim, the teal logo across the top of the oval, the Deckmaster box and the five
 * gems.
 */
export function drawBack(w = 252, h = 352, light: Light = {}, seed = 1): RgbaImage {
  const gems: [number, number, Rgb][] = [
    [0.5, 0.485, [225, 205, 150]],
    [0.395, 0.535, [140, 160, 40]],
    [0.6, 0.535, [40, 160, 190]],
    [0.43, 0.625, [200, 60, 30]],
    [0.57, 0.625, [70, 60, 55]],
  ];
  return paint(
    w,
    h,
    (u, v, rand) => {
      if (u < 0.045 || u > 0.955 || v < 0.035 || v > 0.965) return [22, 19, 11];
      for (const [gu, gv, c] of gems) if (Math.hypot((u - gu) * 63, (v - gv) * 88) < 1.7) return c;
      // The logo: five letters across, each most of its cell.
      if (v > 0.2 && v < 0.315 && u > 0.12 && u < 0.88 && ((u - 0.12) / 0.152) % 1 < 0.78) return mottle([84, 103, 99], rand, 0.1);
      if (v > 0.812 && v < 0.865 && u > 0.22 && u < 0.78) return mottle([92, 104, 89], rand, 0.06);
      const oval = ((u - 0.5) / 0.4) ** 2 + ((v - 0.505) / 0.415) ** 2;
      if (oval < 0.96) return mottle([140, 86, 37], rand, 0.04);
      if (oval < 1) return [96, 92, 150];
      // The frame: darker to the left, lighter and yellower to the right, in coarse blotches like
      // the real one's stone (which is what makes a back count as printed, not a blank surface).
      const t = u;
      const blotch = 0.65 + 0.7 * cellNoise(Math.floor(u * 28), Math.floor(v * 40));
      return mottle([(58 + 44 * t) * blotch, (48 + 30 * t) * blotch, (20 + 3 * t) * blotch], rand, 0.1);
    },
    light,
    seed,
  );
}

export interface FrontLook {
  /** The frame's colour, and the text box's. */
  frame: Rgb;
  box: Rgb;
  /** The artwork's colours: blocks of these. */
  art: Rgb[];
  border?: Rgb;
}

/** A card front in the modern layout: border, frame, title bar, blocky artwork, type line, text box. */
export function drawFront(look: FrontLook, w = 252, h = 352, light: Light = {}, seed = 1): RgbaImage {
  const pick = seeded(seed + 99);
  // The artwork: an 8 × 6 grid of blocks.
  const blocks = Array.from({ length: 48 }, () => look.art[Math.floor(pick() * look.art.length)]!);
  return paint(
    w,
    h,
    (u, v, rand) => {
      if (u < 0.045 || u > 0.955 || v < 0.035 || v > 0.965) return look.border ?? [16, 16, 16];
      const inner = u > 0.085 && u < 0.915;
      if (inner && v > 0.055 && v < 0.105) return mottle([look.box[0] * 0.95, look.box[1] * 0.95, look.box[2] * 0.95], rand, 0.03);
      if (inner && v >= 0.115 && v < 0.555) {
        const i = Math.min(7, Math.floor(((u - 0.085) / 0.83) * 8));
        const j = Math.min(5, Math.floor(((v - 0.115) / 0.44) * 6));
        return mottle(blocks[j * 8 + i]!, rand, 0.08);
      }
      if (inner && v > 0.565 && v < 0.615) return mottle([look.box[0] * 0.95, look.box[1] * 0.95, look.box[2] * 0.95], rand, 0.03);
      if (inner && v > 0.63 && v < 0.9) {
        // Lines of rules text.
        const line = Math.floor((v - 0.63) / 0.027);
        if (line % 2 === 0 && u > 0.11 && u < 0.86 && rand() < 0.45) return [30, 28, 26];
        return mottle(look.box, rand, 0.02);
      }
      return mottle(look.frame, rand, 0.1);
    },
    light,
    seed,
  );
}
