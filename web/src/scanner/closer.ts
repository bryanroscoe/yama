// "Move closer" (Bryan, 15 Nov 2026, and the scanner consult): a hint while the collector line's
// letters are too small to read. The letters' height is estimated from the card's height in the
// camera's full-resolution frame: the collector cut (COLLECTOR_REGION) is two lines high, and a
// capital is about a third of a line's band. On a 2023 frame that's 0.0128 of the card's height,
// which is about 1.1 mm of 88 mm [inferred]. ML Kit wants characters about 16 px tall or more; the
// target is 20 [read: ML Kit text recognition guidance; inferred for these crops]. Measured on
// synthetic frames (docs/scanner.md, "Crop and zoom"): reads held at a card 700 px tall (letters
// about 9 px, upsampled to the reading density) and failed under 450.

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
