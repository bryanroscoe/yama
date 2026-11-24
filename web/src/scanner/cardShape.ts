// Only a card-shaped outline is a card (23 Nov 2026, the public hard-card photos run in the scanner
// lab, docs/scanner.md "Hard cards from public photos"). On fanned hands, overlapping columns and
// boards of cards, the card finder often outlines something that isn't one card: a column (sides
// 1.8 to 1.9 to 1), a sliver (Bryan's own Whiteout misread that day: 12 to 1, a 2.6° corner). The
// art model then names whatever artwork scores best, and a few gallery cards win those reads again
// and again. With no art decision on an outline that isn't convex, whose sides aren't between 1.1
// and 1.8 to 1 (a card is 1.4; perspective moves it) or that has a corner under 55°, held-out wrong
// locks fell from 24 to 10 and the sure ones from 1 to 0, and none of Bryan's 516 labelled scans
// failed it but that Whiteout.

import type { Quad } from "./types";

/** Long side over short side (the mean of opposite sides), from this to that. */
export const SHAPE_RATIO = { min: 1.1, max: 1.8 } as const;
/** The smallest corner, in degrees. */
export const SHAPE_MIN_ANGLE = 55;

/** How card-like four corners are: convex, the ratio of its sides, its smallest corner (degrees). */
export function quadShape(q: Quad): { convex: boolean; ratio: number; minAngle: number } {
  const side = (i: number) => Math.hypot(q[(i + 1) % 4]![0] - q[i]![0], q[(i + 1) % 4]![1] - q[i]![1]);
  const a = (side(0) + side(2)) / 2;
  const b = (side(1) + side(3)) / 2;
  const ratio = Math.max(a, b) / Math.max(Math.min(a, b), 1e-6);
  let minAngle = 180;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < 4; i += 1) {
    const p = q[i]!;
    const prev = q[(i + 3) % 4]!;
    const next = q[(i + 1) % 4]!;
    const v1x = prev[0] - p[0];
    const v1y = prev[1] - p[1];
    const v2x = next[0] - p[0];
    const v2y = next[1] - p[1];
    const cos = (v1x * v2x + v1y * v2y) / Math.max(Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y), 1e-9);
    minAngle = Math.min(minAngle, (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
    // Turning the same way at every corner: convex.
    const cross = v2x * v1y - v2y * v1x;
    if (cross > 0) pos += 1;
    else if (cross < 0) neg += 1;
  }
  return { convex: pos === 4 || neg === 4, ratio, minAngle };
}

/** Whether four corners could be a card: convex, sides SHAPE_RATIO, no corner under SHAPE_MIN_ANGLE. */
export function cardShaped(q: Quad): boolean {
  const s = quadShape(q);
  return s.convex && s.ratio >= SHAPE_RATIO.min && s.ratio <= SHAPE_RATIO.max && s.minAngle >= SHAPE_MIN_ANGLE;
}

/**
 * What an outline is (Codex re-check of #213): "card"; "squat", one card tilted until its outline
 * looks square (convex, its corners fine, its sides under SHAPE_RATIO.min): still one card, whose
 * title and collector line may be read but whose art may not name it by itself; or "junk", anything
 * else (a column of overlapping cards, a sliver, a dented outline): nothing is read from it.
 */
export function outlineKind(q: Quad): "card" | "squat" | "junk" {
  const s = quadShape(q);
  if (!s.convex || s.minAngle < SHAPE_MIN_ANGLE || s.ratio > SHAPE_RATIO.max) return "junk";
  return s.ratio < SHAPE_RATIO.min ? "squat" : "card";
}
