import { describe, expect, it } from "vitest";
import { drawBack, drawFront } from "./eval/syntheticCards";
import { GATE_DEFAULTS, thumbLikeness, THUMB_SIDE } from "./gate";
import { cardThumb, frameSharpness, warpCard } from "./gateFrame";
import type { Quad, RgbaImage } from "./types";

// What the browser camera gives the placement gate from a frame's pixels (gateFrame.ts): how sharp
// the card is, and its thumbnail. The cards are drawn (eval/syntheticCards.ts).

const whole = (im: RgbaImage): Quad => [[0, 0], [im.width - 1, 0], [im.width - 1, im.height - 1], [0, im.height - 1]];
const blue = { frame: [40, 110, 170] as [number, number, number], box: [200, 220, 235] as [number, number, number], art: [[30, 60, 120], [120, 170, 210], [220, 230, 240]] as [number, number, number][] };
const red = { frame: [190, 70, 40] as [number, number, number], box: [235, 200, 180] as [number, number, number], art: [[200, 80, 30], [240, 180, 60], [90, 30, 20]] as [number, number, number][] };

/** The frame blurred by a box of `r` pixels each way. */
function blurred(im: RgbaImage, r: number): RgbaImage {
  const out = new Uint8ClampedArray(im.data.length);
  for (let y = 0; y < im.height; y += 1)
    for (let x = 0; x < im.width; x += 1)
      for (let c = 0; c < 4; c += 1) {
        let t = 0;
        let n = 0;
        for (let dy = -r; dy <= r; dy += 1)
          for (let dx = -r; dx <= r; dx += 1) {
            const px = Math.min(im.width - 1, Math.max(0, x + dx));
            const py = Math.min(im.height - 1, Math.max(0, y + dy));
            t += im.data[(py * im.width + px) * 4 + c]!;
            n += 1;
          }
        out[(y * im.width + x) * 4 + c] = t / n;
      }
  return { width: im.width, height: im.height, data: out };
}

describe("how sharp a frame's card is", () => {
  it("falls as the frame blurs, so the sharpest frame of a placement can be picked", () => {
    const front = drawFront(blue);
    const sharp = frameSharpness(front, whole(front));
    const soft = frameSharpness(blurred(front, 1), whole(front));
    const softer = frameSharpness(blurred(front, 3), whole(front));
    expect(sharp).toBeGreaterThan(soft * 1.5);
    expect(soft).toBeGreaterThan(softer * 1.5);
  });

  it("warps the card upright to the size asked, whatever its size in the frame", () => {
    const front = drawFront(blue, 126, 176);
    const g = warpCard(front, whole(front), 40, 56);
    expect([g.width, g.height, g.data.length]).toEqual([40, 56, 40 * 56]);
  });
});

describe("a card's thumbnail", () => {
  it(`is ${THUMB_SIDE} px square, and the same card's at another size or in dimmer light matches`, () => {
    const a = drawFront(blue, 252, 352, {}, 1);
    const t = cardThumb(a, whole(a));
    expect(t.length).toBe(THUMB_SIDE * THUMB_SIDE);
    const smaller = drawFront(blue, 189, 264, { brightness: 0.7, noise: 4 }, 1);
    expect(thumbLikeness(t, cardThumb(smaller, whole(smaller)))).toBeGreaterThan(GATE_DEFAULTS.sameThumb + 0.05);
    // With the finder's corners a pixel or two off, as they are from pass to pass.
    expect(thumbLikeness(t, cardThumb(smaller, [[2, 3], [186, 1], [188, 262], [1, 263]]))).toBeGreaterThan(GATE_DEFAULTS.sameThumb + 0.05);
  });

  it("doesn't match another card's, nor a back's", () => {
    const a = drawFront(blue);
    const b = drawFront(red, 252, 352, {}, 5);
    const back = drawBack();
    const t = cardThumb(a, whole(a));
    // Under the gate's 0.85, with room: another card, another card in the same frame colour, a back.
    const others = [cardThumb(b, whole(b)), cardThumb(drawFront(blue, 252, 352, {}, 9), whole(a)), cardThumb(back, whole(back))].map((o) => thumbLikeness(t, o));
    expect(Math.max(...others)).toBeLessThan(GATE_DEFAULTS.sameThumb - 0.1);
  });
});
