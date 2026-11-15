import { describe, expect, it } from "vitest";
import { AUTO_MAX, AutoZoom, autoCeiling, maySwitchLens, STEADY, STEP_MS } from "./zoomPolicy";
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
