import { describe, expect, it } from "vitest";
import { AUTO_MAX, AutoZoom, autoCeiling, maySwitchLens, STEADY, STEP_MS, WIDE_AFTER_MS, WIDE_BACK_MS, WideOnStruggle } from "./zoomPolicy";
import { cardHeight, LETTER_SHARE, letterPx, tooFar } from "./closer";
import { rectQuad } from "./image";

describe("auto-zoom", () => {
  it("never goes past the lens-switch cap, or under 1×", () => {
    expect(autoCeiling({ min: 1, max: 10 })).toBe(AUTO_MAX);
    expect(autoCeiling({ min: 1, max: 2 })).toBe(2);
    expect(autoCeiling({ min: 0.5, max: 8 })).toBe(AUTO_MAX);
    expect(maySwitchLens({ min: 1, max: 10 })).toBe(true);
    expect(maySwitchLens({ min: 1, max: 4 })).toBe(false);
    expect(maySwitchLens(null)).toBe(false);
  });

  it("steps in gently while the card is small, after a few steady frames and a pause", () => {
    const z = new AutoZoom({ min: 1, max: 10 });
    const steps: (number | null)[] = [];
    for (let i = 0; i < STEADY; i++) steps.push(z.frame(0.3, 1, i * 100));
    expect(steps.slice(0, -1)).toEqual(Array(STEADY - 1).fill(null));
    expect(steps.at(-1)).toBe(1.15);
    // No second step before the pause, even with steady frames.
    for (let i = 0; i < STEADY; i++) expect(z.frame(0.35, 1.15, 300 + i * 100)).toBeNull();
    let zoom = 1.15;
    for (let t = 1000; t < 20000; t += 100) {
      const next = z.frame(0.25, zoom, t);
      if (next) zoom = next;
    }
    expect(zoom).toBe(AUTO_MAX);
  });

  it("doesn't overshoot the share aimed for, steps out when the card is cut off, and rests in between", () => {
    const z = new AutoZoom({ min: 1, max: 10 });
    let out: number | null = null;
    for (let i = 0; i < STEADY; i++) out = z.frame(0.44, 1, i * 10);
    // 0.44 → 0.6 needs 1.36×, more than a step: one step.
    expect(out).toBe(1.15);
    const back = new AutoZoom({ min: 1, max: 10 });
    for (let i = 0; i < STEADY; i++) out = back.frame(0.95, 2, i * 10);
    expect(out).toBeCloseTo(1.75, 2);
    const still = new AutoZoom({ min: 1, max: 10 });
    for (let i = 0; i < 10; i++) expect(still.frame(0.6, 1.5, i * STEP_MS)).toBeNull();
    // No card: nothing, and the run starts again.
    expect(still.frame(null, 1.5, 99999)).toBeNull();
  });
});

describe("move closer", () => {
  it("estimates the collector letters from the card's height", () => {
    expect(LETTER_SHARE).toBeCloseTo(0.0128, 4);
    expect(cardHeight(rectQuad(0, 0, 1000, 1397))).toBeCloseTo(1397, 3);
    expect(letterPx(rectQuad(0, 0, 1000, 1397))).toBeCloseTo(17.9, 1);
  });

  it("asks to move closer until the letters are about 20 px tall", () => {
    // A card 1,250 px tall: 16 px letters. 1,600 px: 20.5 px.
    expect(tooFar(rectQuad(0, 0, 895, 1250))).toBe(true);
    expect(tooFar(rectQuad(0, 0, 1146, 1600))).toBe(false);
  });
});

describe("whether auto-zoom has room left (so the distance hints wait for it)", () => {
  it("can zoom in up to its ceiling and out down to 1× or the camera's least", () => {
    const az = new AutoZoom({ min: 0.5, max: 30 });
    expect(az.canZoomIn(1)).toBe(true);
    expect(az.canZoomIn(AUTO_MAX)).toBe(false);
    expect(az.canZoomOut(1)).toBe(false);
    expect(az.canZoomOut(1.5)).toBe(true);
    const fixed = new AutoZoom({ min: 1, max: 1 });
    expect(fixed.canZoomIn(1)).toBe(false);
    expect(fixed.canZoomOut(1)).toBe(false);
  });
});

describe("going wide when a card struggles", () => {
  const pixel = { min: 0.507, max: 30 };
  it("steps out to the wide lens once a steady card goes unnamed, and back to 1x once the view is empty", () => {
    const w = new WideOnStruggle(pixel);
    expect(w.can).toBe(true);
    let t = 0;
    for (; t < WIDE_AFTER_MS; t += 100) expect(w.frame(0.6, true, false, 1, t)).toBeNull();
    expect(w.frame(0.6, true, false, 1, t)).toBe(0.5);
    expect(w.isWide).toBe(true);
    // Named now, still in view: stays wide.
    expect(w.frame(0.3, true, true, 0.5, (t += 100))).toBeNull();
    // Gone: back to 1x after a moment.
    expect(w.frame(null, false, false, 0.5, (t += 100))).toBeNull();
    expect(w.frame(null, false, false, 0.5, (t += WIDE_BACK_MS))).toBe(1);
    expect(w.isWide).toBe(false);
    // Gone, with the finder's "cards" jumping on the empty table: back to 1x all the same.
    const v = new WideOnStruggle(pixel);
    let u = 0;
    for (; u <= WIDE_AFTER_MS; u += 100) v.frame(0.6, true, false, 1, u);
    expect(v.isWide).toBe(true);
    expect(v.frame(0.9, false, false, 0.5, (u += 100))).toBeNull();
    expect(v.frame(0.4, false, false, 0.5, (u += WIDE_BACK_MS))).toBe(1);
  });

  it("never for a 'card' that jumps (nothing there), a card named quickly, or a camera with no wider lens", () => {
    const w = new WideOnStruggle(pixel);
    for (let t = 0; t < 3 * WIDE_AFTER_MS; t += 100) expect(w.frame(0.6, t % 300 !== 0, false, 1, t)).toBeNull();
    const named = new WideOnStruggle(pixel);
    for (let t = 0; t < 3 * WIDE_AFTER_MS; t += 100) expect(named.frame(0.6, true, true, 1, t)).toBeNull();
    const one = new WideOnStruggle({ min: 1, max: 8 });
    expect(one.can).toBe(false);
    for (let t = 0; t < 3 * WIDE_AFTER_MS; t += 100) expect(one.frame(0.6, true, false, 1, t)).toBeNull();
  });

  it("steps out at once when a card held at 1x overfills the view", () => {
    const w = new WideOnStruggle(pixel);
    expect(w.frame(0.9, true, false, 1, 0)).toBeNull();
    expect(w.frame(0.9, true, false, 1, 33)).toBeNull();
    expect(w.frame(0.9, true, false, 1, 66)).toBe(0.5);
  });
});
