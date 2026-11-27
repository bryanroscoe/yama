// Where on a card the scanner's crops are cut, and cutting them: the collector strip, the set
// symbol's area and the whole card, each warped upright from the card's corners at the card's own
// resolution in the image (never enlarged). Used by Scanner diagnostics (diagnostics.ts) and scan
// photos (samples.ts, photoCut.ts). No API or DOM here, so the scan photo worker can use it.

import type { FrameCapture } from "./cameraSource";
import { warpRegionRgba, type CardRegion } from "./image";
import type { Quad, RgbaImage } from "./types";

/** A card in view and the image it's in. */
export interface Shot {
  image: RgbaImage;
  quad: Quad;
  /** A photo, not a camera's frame: no other frame of it will come (its first read isn't skipped for blur). */
  still?: boolean;
  /** What the camera said of the frame as it took it (the app's camera; cameraSource.ts). */
  capture?: FrameCapture;
}

/** The card's bottom edge, corner to corner: both collector areas, with room for a card cut high. */
export const STRIP: CardRegion = { x0: 0, y0: 0.86, x1: 1, y1: 1 };
/** The longest side of the card photo kept. */
export const CARD_SIDE = 640;
/** The whole card, corner to corner: the photo kept is the card alone, never the frame around it. */
const WHOLE: CardRegion = { x0: 0, y0: 0, x1: 1, y1: 1 };
/** A strip is never drawn wider than this (a card nearly filling a 4K frame). */
export const STRIP_MAX = 2400;
/**
 * The set symbol's area: the type line's right end, with room for a card cut a little off (card
 * y 0.50 to 0.63, x 0.70 to 1). What a printing model looks at (docs/plans/scanner-models.md).
 */
export const SYMBOL: CardRegion = { x0: 0.7, y0: 0.5, x1: 1, y1: 0.63 };
/** A symbol crop is never drawn wider than this. */
export const SYMBOL_MAX = 800;
/** Pixels across the strip at the card's own resolution (never enlarged), and its height. */
export function stripSize(quad: Quad): { width: number; height: number } {
  const cardW = Math.max(Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]), Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]));
  const width = Math.max(64, Math.min(STRIP_MAX, Math.round(cardW * (STRIP.x1 - STRIP.x0))));
  const height = Math.max(8, Math.round((width * ((STRIP.y1 - STRIP.y0) * 88)) / ((STRIP.x1 - STRIP.x0) * 63)));
  return { width, height };
}

/** The card's bottom strip, warped upright at the card's own resolution in the frame. */
export function stripOf(shot: Shot): RgbaImage {
  const { width, height } = stripSize(shot.quad);
  return warpRegionRgba(shot.image, shot.quad, STRIP, width, height);
}

/** Pixels across the set symbol's area at the card's own resolution (never enlarged, at most SYMBOL_MAX), and its height. */
export function symbolSize(quad: Quad): { width: number; height: number } {
  const cardW = Math.max(Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]), Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]));
  const width = Math.max(32, Math.min(SYMBOL_MAX, Math.round(cardW * (SYMBOL.x1 - SYMBOL.x0))));
  const height = Math.max(8, Math.round((width * ((SYMBOL.y1 - SYMBOL.y0) * 88)) / ((SYMBOL.x1 - SYMBOL.x0) * 63)));
  return { width, height };
}

/** The set symbol's area, warped upright at the card's own resolution in the frame: only the card. */
export function symbolOf(shot: Shot): RgbaImage {
  const { width, height } = symbolSize(shot.quad);
  return warpRegionRgba(shot.image, shot.quad, SYMBOL, width, height);
}

/**
 * The card alone, warped upright, at most `maxHeight` tall (CARD_SIDE unless said; never
 * enlarged): nothing of the camera frame or photo around it, which may show the room, a hand or
 * other cards.
 */
export function cardOf(shot: Shot, maxHeight = CARD_SIDE): RgbaImage {
  const q = shot.quad;
  const cardH = Math.max(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]));
  const height = Math.max(8, Math.min(maxHeight, Math.round(cardH)));
  const width = Math.max(6, Math.round((height * 63) / 88));
  return warpRegionRgba(shot.image, shot.quad, WHOLE, width, height);
}

/**
 * The card's corners in a strip image's pixels (top above the image): reading the strip with
 * readCollectorLines as if it were the whole card cuts the same corners. For replay.
 */
export function stripQuad(width: number, height: number): Quad {
  const cardH = height / (STRIP.y1 - STRIP.y0);
  const top = height - cardH * STRIP.y1;
  return [
    [0, top],
    [width, top],
    [width, top + cardH],
    [0, top + cardH],
  ];
}
