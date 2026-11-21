// Is the card in view lying face down? (docs/plans/scanner-match-cardvision.md, item 18.) A standard
// Magic card back is a flat orange-brown oval inside a darker olive-brown frame, with almost nothing
// blue on it but the logo and the Deckmaster box. That's checked from colour and layout alone, on the
// frame the card finder already looked at, with thresholds kept as numbers: no card image ships.
//
// Every zone is the same under a half turn, a quarter turn and a mirror of the quad, because the card
// finder's idea of "top" means nothing on a back.

import type { Quad, RgbaImage } from "./types";

/** What was measured, for tests and for retuning. */
export interface BackSigns {
  /** Share of the middle of the card that is orange-brown (0 to 1). */
  orange: number;
  /** Share of the middle within a quarter of its median brightness: the oval is flat, artwork isn't. */
  flat: number;
  /** Share of the whole card whose weakest channel is blue. */
  warm: number;
  /** How many of the four corner blocks are warm (0 to 4). */
  corners: number;
  /** The corners' mean brightness over the middle's: the frame is darker than the oval. */
  frame: number;
  /**
   * Share of the whole card that is plainly bluer than the middle (its share of blue COOLER more):
   * the logo and the Deckmaster box, about a seventh of a back, under any light.
   */
  cool: number;
}

/** Samples across and down the card. */
const GRID = 24;
/** The card's own black border is left out. */
const INSET = 0.05;
/** Half the side of the middle square, as a share of the card: inside the oval, under the logo either way up. */
const MIDDLE = 0.14;
/** The corner blocks: this far in from each edge, on both axes. */
const CORNER: readonly [number, number] = [0.07, 0.17];
/** A sample is "cool" when its share of blue is this much over the middle's. */
const COOLER = 0.08;

/**
 * Thresholds, from Scryfall's scan of the back measured at build time (not kept) and the same scan
 * under red and blue gains of 0.75 to 1.6, half to one and a half times the brightness,
 * blur and sensor noise (358 of 432 such variants pass; the ones that don't are dim and washed out
 * together); and against 883 scans of card fronts, each under five colour casts: none passes
 * (docs/scanner.md, "Card backs").
 * The oval measures red 0.53, green 0.33, blue 0.14 of its light; the frame about 0.45, 0.37, 0.17.
 */
export const BACK = {
  /** A sample is orange-brown at this share of red or more, this share of blue or less, and green not under blue. */
  red: 0.4,
  blue: 0.26,
  /** A sample is warm when blue is its weakest channel and at most this share. */
  warmBlue: 0.3,
  orange: 0.85,
  flat: 0.92,
  warm: 0.75,
  /** The corners' brightness over the oval's, between these (a front's black corners are darker still). */
  frame: [0.45, 0.85],
  /** The logo and Deckmaster box: between these shares of the card is plainly bluer than the oval. */
  cool: [0.095, 0.32],
} as const;

interface Sample {
  r: number;
  g: number;
  b: number;
}

/** The mean colour of a 3 × 3 block at (u, v) of the card, bilinear across the quad's corners. */
function sampleAt(frame: RgbaImage, quad: Quad, u: number, v: number): Sample {
  const [a, b, c, d] = quad;
  const x = Math.round((1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]));
  const y = Math.round((1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1]));
  let r = 0;
  let g = 0;
  let bl = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = Math.min(frame.width - 1, Math.max(0, x + dx));
      const py = Math.min(frame.height - 1, Math.max(0, y + dy));
      const k = (py * frame.width + px) * 4;
      r += frame.data[k]!;
      g += frame.data[k + 1]!;
      bl += frame.data[k + 2]!;
    }
  }
  return { r: r / 9, g: g / 9, b: bl / 9 };
}

const lum = (s: Sample) => 0.299 * s.r + 0.587 * s.g + 0.114 * s.b;
const isWarm = (s: Sample) => {
  const sum = s.r + s.g + s.b;
  return sum > 0 && s.b <= s.r && s.b <= s.g && s.b / sum <= BACK.warmBlue;
};
const isOrange = (s: Sample) => {
  const sum = s.r + s.g + s.b;
  return sum > 0 && s.r / sum >= BACK.red && s.b / sum <= BACK.blue && s.g >= s.b;
};

export function backSigns(frame: RgbaImage, quad: Quad): BackSigns {
  const at = (i: number) => INSET + ((1 - 2 * INSET) * i) / (GRID - 1);
  const middle: Sample[] = [];
  const corners: Sample[][] = [[], [], [], []];
  let warm = 0;
  const everything: Sample[] = [];
  const inCorner = (t: number) => (t >= CORNER[0] && t <= CORNER[1] ? 0 : 1 - t >= CORNER[0] && 1 - t <= CORNER[1] ? 1 : -1);
  for (let j = 0; j < GRID; j += 1) {
    const v = at(j);
    for (let i = 0; i < GRID; i += 1) {
      const u = at(i);
      const s = sampleAt(frame, quad, u, v);
      everything.push(s);
      if (isWarm(s)) warm += 1;
      if (Math.abs(u - 0.5) <= MIDDLE && Math.abs(v - 0.5) <= MIDDLE) middle.push(s);
      const cu = inCorner(u);
      const cv = inCorner(v);
      if (cu >= 0 && cv >= 0) corners[cv * 2 + cu]!.push(s);
    }
  }
  const lums = middle.map(lum).sort((x, y) => x - y);
  const median = lums[Math.floor(lums.length / 2)] ?? 0;
  const mean = (list: Sample[]): Sample => {
    const t = list.reduce((acc, s) => ({ r: acc.r + s.r, g: acc.g + s.g, b: acc.b + s.b }), { r: 0, g: 0, b: 0 });
    const n = Math.max(1, list.length);
    return { r: t.r / n, g: t.g / n, b: t.b / n };
  };
  const cornerMeans = corners.map(mean);
  const middleMean = mean(middle);
  const middleLum = lum(middleMean);
  const all = everything.length;
  const blueOf = (s: Sample) => s.b / Math.max(1, s.r + s.g + s.b);
  const middleBlue = blueOf(middleMean);
  return {
    orange: middle.length ? middle.filter(isOrange).length / middle.length : 0,
    flat: lums.length ? lums.filter((l) => Math.abs(l - median) <= 0.25 * median).length / lums.length : 0,
    warm: all ? warm / all : 0,
    corners: cornerMeans.filter(isWarm).length,
    frame: middleLum > 0 ? cornerMeans.reduce((t, s) => t + lum(s), 0) / 4 / middleLum : Infinity,
    cool: all ? everything.filter((s) => blueOf(s) >= middleBlue + COOLER).length / all : 0,
  };
}

/** Whether these measurements are a card back's. */
export const looksLikeBack = (s: BackSigns): boolean => s.orange >= BACK.orange && s.flat >= BACK.flat && s.warm >= BACK.warm && s.corners === 4 && s.frame >= BACK.frame[0] && s.frame <= BACK.frame[1] && s.cool >= BACK.cool[0] && s.cool <= BACK.cool[1];

/** Whether the card at `quad` shows a standard Magic card back. */
export const isCardBack = (frame: RgbaImage, quad: Quad): boolean => looksLikeBack(backSigns(frame, quad));

/**
 * Whether the scanner says "Card back, turn the card over" for this frame: the card looks like a
 * back, and the art's best match scores under `known` (ScannerView's LOCK_TWICE). A card front the
 * art knows fairly well is never called a back, so a front can't be held up by its colours.
 */
export const saysCardBack = (back: boolean | undefined, topScore: number, known: number): boolean => back === true && topScore < known;
