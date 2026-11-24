import { describe, expect, it } from "vitest";
import { cardSheen, FOIL_HUES, FOIL_SPREAD, hasTextBox, lab, looksFoil, SheenWatch } from "./foil";
import type { Quad, RgbaImage } from "./types";

const W = 300;
const H = 420;
/** The lab's synthetic frames (scanner lab glare/sheen2.py), pixel for pixel. */
function synth(kind: "rainbow" | "cream" | "warm"): RgbaImage {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      const k = (y * W + x) * 4;
      const [r, g, b] =
        kind === "rainbow"
          ? [(x * 7 + y * 3) % 256, (x * 5 + y * 11) % 256, (x * 13 + y * 2) % 256]
          : kind === "cream"
            ? [230 + (x % 3), 222 + (y % 2), 200 + ((x + y) % 4)]
            : [200 + Math.floor(x / 12), 190, 170 - Math.floor(x / 10)];
      data[k] = r;
      data[k + 1] = g;
      data[k + 2] = b;
      data[k + 3] = 255;
    }
  return { width: W, height: H, data };
}
const QUAD: Quad = [
  [20, 30],
  [280, 30],
  [280, 393],
  [20, 393],
];

describe("a card's sheen (foil.ts)", () => {
  it("matches the lab's measure that was calibrated on real scans", () => {
    // Python's figures for the same frames (glare/sheen2.py `feats(points(...))`).
    const rainbow = cardSheen(synth("rainbow"), QUAD);
    expect(rainbow.spread).toBeCloseTo(70.71921696800513, 6);
    expect(rainbow.hues).toBe(6);
    const cream = cardSheen(synth("cream"), QUAD);
    expect(cream.spread).toBeCloseTo(0.08074777787942715, 6);
    expect(cream.hues).toBe(0);
    const warm = cardSheen(synth("warm"), QUAD);
    expect(warm.spread).toBeCloseTo(2.5065875586731017, 6);
    expect(warm.hues).toBe(0);
    expect(looksFoil(rainbow)).toBe(true);
    expect(looksFoil(cream)).toBe(false);
  });

  it("converts sRGB to Lab as the lab does (white, black, a red)", () => {
    const white = lab(255, 255, 255);
    expect(white[0]).toBeCloseTo(100, 1);
    expect(Math.abs(white[1])).toBeLessThan(0.5);
    expect(lab(0, 0, 0)[0]).toBeCloseTo(0, 6);
    expect(lab(255, 0, 0)[1]).toBeGreaterThan(70);
  });

  it("needs both the spread and several hues: one strong cast isn't a foil", () => {
    expect(looksFoil({ spread: FOIL_SPREAD + 20, hues: FOIL_HUES - 1 })).toBe(false);
    expect(looksFoil({ spread: FOIL_SPREAD - 1, hues: 6 })).toBe(false);
    expect(looksFoil({ spread: FOIL_SPREAD, hues: FOIL_HUES })).toBe(true);
  });

  it("judges only printings with a text box", () => {
    expect(hasTextBox(null)).toBe(true);
    expect(hasTextBox({ full_art: false, border_color: "black" })).toBe(true);
    expect(hasTextBox({ full_art: true, border_color: "black" })).toBe(false);
    expect(hasTextBox({ full_art: false, border_color: "borderless" })).toBe(false);
  });
});

describe("SheenWatch", () => {
  it("is a foil on one frame, sure on two or on four hues, and starts again after reset", () => {
    const w = new SheenWatch();
    w.add({ spread: 3, hues: 5 });
    expect(w.verdict()).toMatchObject({ foil: false, sure: false, frames: 1, foilFrames: 0 });
    w.add({ spread: 14, hues: 3 });
    // (The plain frame's five hues don't make the one foil frame sure.)
    expect(w.verdict()).toMatchObject({ foil: true, sure: false, frames: 2, foilFrames: 1, hues: 3 });
    w.add({ spread: 22, hues: 3 });
    expect(w.verdict()).toMatchObject({ foil: true, sure: true, foilFrames: 2, spread: 22 });
    w.reset();
    expect(w.verdict()).toMatchObject({ foil: false, frames: 0 });
    w.add({ spread: 30, hues: 4 });
    expect(w.verdict().sure).toBe(true);
    w.add(null);
    expect(w.verdict().frames).toBe(1);
  });
});
