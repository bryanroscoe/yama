// "Move closer" (Bryan, 15 Nov 2026, and the scanner consult): a hint while the collector line's
// letters are too small to read. The letters' height is estimated from the card's height in the
// camera's full-resolution frame: the collector cut (COLLECTOR_REGION) is two lines high, and a
// capital is about a third of a line's band. On a 2023 frame that's 0.0128 of the card's height,
// which is about 1.1 mm of 88 mm [inferred]. ML Kit wants characters about 16 px tall or more; the
// target is 20 [read: ML Kit text recognition guidance; inferred for these crops]. Measured on
// synthetic frames (docs/scanner.md, "Crop and zoom"): reads held at a card 700 px tall (letters
// about 9 px, upsampled to the reading density) and failed under 450.

import { MIN_SHOWN } from "./fit";
import { COLLECTOR_REGION } from "./pipeline";
import type { Quad } from "./types";

/** A collector-line capital's height as a share of the card's height. */
export const LETTER_SHARE = ((COLLECTOR_REGION.y1 - COLLECTOR_REGION.y0) / 2) * 0.32;
/** Letters this tall in the frame are comfortably readable. */
export const LETTER_TARGET = 20;

/** The card's height in pixels: the mean of its left and right edges. */
export function cardHeight(q: Quad): number {
  return (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
}

/** The estimated height of the collector line's capitals, in frame pixels. */
export const letterPx = (q: Quad) => cardHeight(q) * LETTER_SHARE;

/** Whether to say "Move closer": the letters would be under the target. */
export const tooFar = (q: Quad) => letterPx(q) < LETTER_TARGET;

// "Hold the phone a little further away" (Bryan, 22 Nov 2026: up close the picture "looks a little
// distorted"). His Pixel, on Automatic, had switched to its ultra-wide lens for a card that close
// (Scanner diagnostics' activeLens, two records that day), and the app's camera now keeps to the
// main lens by default (nativeCamera.ts). A single lens can't focus nearer than its nearest focus
// distance, so the card is then soft: how far away the card is, is estimated from its height in
// the picture and the lens's focal length as a 35 mm camera's, and below that distance the scanner
// asks for a little more room. Assumed [inferred, not measured on a phone]: a 4:3 sensor (the
// app's equivalent focal length is by its diagonal, 43.27 mm), its long side upright in a 16:9
// picture taken from it, and the card upright (a card on its side seems further away, never nearer).

/** A 4:3 sensor's long side, in a 35 mm camera's millimetres (four fifths of its 43.27 mm diagonal). */
const LONG_SIDE_MM = 34.6;
/** A card's height, in metres. */
const CARD_M = 0.088;

/** How far away the card is, in metres, from its share of the picture's height; null when it can't be told. */
export function cardDistance(share: number, equivalentMm: number, zoom = 1): number | null {
  if (!(share > 0 && equivalentMm > 0 && zoom > 0)) return null;
  return (CARD_M * equivalentMm * zoom) / (LONG_SIDE_MM * share);
}

/** A lens the estimate is trusted for: a focal length and nearest focus a phone's lens could have. */
export interface FocusLens {
  /** Focal length as a 35 mm camera's, mm. */
  equivalent: number;
  /** As near as it focuses, metres. */
  nearest: number;
}

/** The card is nearer than the lens focuses (with a tenth to spare), so the picture is soft. */
export function tooCloseToFocus(share: number, lens: FocusLens | null, zoom = 1): boolean {
  if (!lens || lens.equivalent < 12 || lens.equivalent > 150 || !(lens.nearest >= 0.03 && lens.nearest <= 1)) return false;
  const d = cardDistance(share, lens.equivalent, zoom);
  return d != null && d < lens.nearest * 0.9;
}

/** Past this share of the picture's height the card may be cut off on screen (fit.ts) or at the frame's edge. */
export const TOO_BIG = MIN_SHOWN;
