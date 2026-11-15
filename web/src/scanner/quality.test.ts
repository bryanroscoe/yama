import { describe, expect, it } from "vitest";
import { clippedShare, halve, laplacianVariance, worthReading } from "./quality";
import type { Gray } from "./types";

const img = (w: number, h: number, f: (x: number, y: number) => number): Gray => {
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) data[y * w + x] = f(x, y);
  return { width: w, height: h, data };
};

describe("strip quality", () => {
  it("scores sharp print far above a smooth ramp", () => {
    const text = img(64, 16, (x) => (x % 4 < 2 ? 20 : 230));
    const ramp = img(64, 16, (x) => x * 3);
    expect(laplacianVariance(text)).toBeGreaterThan(1000);
    expect(laplacianVariance(ramp)).toBeLessThan(1);
  });

  it("measures glare as the share of clipped pixels", () => {
    expect(clippedShare(img(10, 10, (x) => (x < 3 ? 255 : 100)))).toBeCloseTo(0.3);
  });

  it("averages 2 × 2 when halving", () => {
    expect([...halve(img(2, 2, (x, y) => [0, 100, 100, 200][y * 2 + x]!)).data]).toEqual([100]);
  });

  it("reads a frame only when it's sharp enough and not washed out", () => {
    expect(worthReading({ sharpness: 300, clipped: 0.05 })).toBe(true);
    expect(worthReading({ sharpness: 40, clipped: 0 })).toBe(false);
    expect(worthReading({ sharpness: 300, clipped: 0.5 })).toBe(false);
  });
});
