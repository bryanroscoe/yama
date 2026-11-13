import { describe, expect, it } from "vitest";
import { cardDetail, MIN_DETAIL } from "./recognizer";
import type { Quad, RgbaImage } from "./types";

/** A w × h grey image from a brightness function, with seeded noise of `sigma`. */
function image(w: number, h: number, at: (x: number, y: number) => number, sigma = 0): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let k = 0; k < 6; k++) n += rnd();
      const v = at(x, y) + sigma * (n - 3) * Math.SQRT2;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const whole = (img: RgbaImage): Quad => [[0, 0], [img.width, 0], [img.width, img.height], [0, img.height]];

describe("cardDetail", () => {
  it("reads a blank surface as blank, even with lighting and heavy noise", () => {
    // The phone's view of a white sheet: brighter at the top, sensor noise. Blank art matched
    // Mystery Booster 2's Whiteout before (13 Nov 2026).
    const sheet = image(480, 640, (x, y) => 225 - 40 * (y / 640) - 15 * (x / 480), 12);
    expect(cardDetail(sheet, whole(sheet))).toBeLessThan(MIN_DETAIL);
  });

  it("reads a printed card as detailed, even one with a blank art box", () => {
    // A small card (220 × 307): dark border, title bar, a blank art box, and rules text lines.
    const card = image(220, 307, (x, y) => {
      if (x < 10 || x > 209 || y < 10 || y > 296) return 20;
      if (y < 34) return x % 9 < 5 && x > 20 && x < 150 ? 40 : 200;
      if (y < 170) return 245;
      if (y > 190 && y < 280 && y % 12 < 4 && (x * 7) % 11 < 7) return 50;
      return 215;
    }, 3);
    expect(cardDetail(card, whole(card))).toBeGreaterThan(MIN_DETAIL * 2);
  });

  it("looks only inside the quad", () => {
    // Busy stripes around a plain middle: the plain middle is what counts.
    const img = image(400, 400, (x, y) => (x > 100 && x < 300 && y > 60 && y < 340 ? 230 : x % 4 < 2 ? 0 : 255));
    const middle: Quad = [[110, 70], [290, 70], [290, 330], [110, 330]];
    expect(cardDetail(img, middle)).toBeLessThan(MIN_DETAIL);
    expect(cardDetail(img, whole(img))).toBeGreaterThan(MIN_DETAIL);
  });
});
