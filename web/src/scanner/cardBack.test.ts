import { describe, expect, it } from "vitest";
import { backSigns, isCardBack, looksLikeBack, saysCardBack } from "./cardBack";
import { drawBack, drawFront, type FrontLook, type Light } from "./eval/syntheticCards";
import type { Quad, RgbaImage } from "./types";

// "Card back, turn the card over" (cardBack.ts): a back is told from colour and layout alone. The
// cards here are drawn (eval/syntheticCards.ts); no card image is in the repository. The thresholds
// were set against a real scan of the back and 883 real fronts at build time (docs/scanner.md).

const whole = (im: RgbaImage): Quad => [[0, 0], [im.width - 1, 0], [im.width - 1, im.height - 1], [0, im.height - 1]];

/** The card laid into a larger grey frame at an offset, as the camera sees it, with its quad. */
function onTable(card: RgbaImage, dx = 40, dy = 30): { frame: RgbaImage; quad: Quad } {
  const width = card.width + 2 * dx;
  const height = card.height + 2 * dy;
  const data = new Uint8ClampedArray(width * height * 4).fill(120);
  for (let y = 0; y < card.height; y += 1) data.set(card.data.subarray(y * card.width * 4, (y + 1) * card.width * 4), ((y + dy) * width + dx) * 4);
  return { frame: { width, height, data }, quad: [[dx, dy], [dx + card.width - 1, dy], [dx + card.width - 1, dy + card.height - 1], [dx, dy + card.height - 1]] };
}

const FRONTS: Record<string, FrontLook> = {
  white: { frame: [225, 222, 205], box: [240, 236, 222], art: [[90, 130, 190], [230, 220, 180], [120, 90, 60]] },
  blue: { frame: [40, 110, 170], box: [200, 220, 235], art: [[30, 60, 120], [120, 170, 210], [220, 230, 240]] },
  black: { frame: [50, 46, 48], box: [190, 180, 175], art: [[30, 20, 40], [90, 50, 110], [160, 150, 140]] },
  red: { frame: [190, 70, 40], box: [235, 200, 180], art: [[200, 80, 30], [240, 180, 60], [90, 30, 20]] },
  green: { frame: [60, 120, 70], box: [205, 220, 195], art: [[40, 90, 40], [150, 180, 90], [90, 70, 40]] },
  // The hard ones: gold and brown frames with warm artwork, which are orange-brown nearly all over.
  gold: { frame: [200, 165, 90], box: [235, 215, 160], art: [[150, 90, 40], [200, 130, 50], [110, 70, 30]] },
  oldArtifact: { frame: [120, 85, 55], box: [215, 195, 160], art: [[140, 86, 37], [150, 95, 45], [125, 78, 34]] },
  desert: { frame: [190, 70, 40], box: [230, 190, 150], art: [[140, 86, 37], [145, 90, 40], [135, 82, 35]] },
};

const LIGHTS: Record<string, Light> = {
  plain: {},
  warm: { gain: [1.3, 1, 0.75] },
  cool: { gain: [0.85, 1, 1.3] },
  dim: { brightness: 0.55, noise: 6 },
  bright: { brightness: 1.45 },
  noisy: { noise: 14 },
};

describe("a card back is told from its colours and layout", () => {
  it("measures a back as an orange-brown, flat middle in a darker warm frame with a little teal", () => {
    const back = drawBack();
    const s = backSigns(back, whole(back));
    expect(s.orange).toBeGreaterThan(0.9);
    expect(s.flat).toBeGreaterThan(0.92);
    expect(s.corners).toBe(4);
    expect(s.frame).toBeGreaterThan(0.45);
    expect(s.frame).toBeLessThan(0.85);
    expect(s.cool).toBeGreaterThan(0.095);
    expect(s.cool).toBeLessThan(0.32);
    expect(looksLikeBack(s)).toBe(true);
  });

  it.each(Object.entries(LIGHTS))("knows a back under %s light, at two sizes", (_, light) => {
    for (const [w, h] of [[252, 352], [126, 176]] as const) {
      const back = drawBack(w, h, light, 3);
      expect(isCardBack(back, whole(back))).toBe(true);
    }
  });

  it("knows a back whichever corner the finder calls the top, and mirrored", () => {
    const back = drawBack();
    const q = whole(back);
    for (let turn = 0; turn < 4; turn += 1) {
      const turned = [q[turn % 4]!, q[(turn + 1) % 4]!, q[(turn + 2) % 4]!, q[(turn + 3) % 4]!] as Quad;
      expect(isCardBack(back, turned)).toBe(true);
      expect(isCardBack(back, [turned[1], turned[0], turned[3], turned[2]])).toBe(true);
    }
  });

  it("knows a back where it lies in a larger frame", () => {
    const { frame, quad } = onTable(drawBack(189, 264, { noise: 5 }));
    expect(isCardBack(frame, quad)).toBe(true);
  });

  it.each(Object.keys(FRONTS))("never takes a %s front for a back, under any of the lights", (name) => {
    for (const light of Object.values(LIGHTS)) {
      for (const seed of [1, 2, 3]) {
        const front = drawFront(FRONTS[name]!, 252, 352, light, seed);
        expect(isCardBack(front, whole(front))).toBe(false);
      }
    }
  });

  it("takes neither a blank sheet nor a plain orange sleeve for a back", () => {
    for (const c of [[240, 240, 240], [140, 86, 37], [30, 30, 30]] as const) {
      const data = new Uint8ClampedArray(200 * 280 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([c[0], c[1], c[2], 255], i);
      const sheet: RgbaImage = { width: 200, height: 280, data };
      expect(isCardBack(sheet, whole(sheet))).toBe(false);
    }
  });
});

describe("when the scanner says Card back", () => {
  it("only when the card looks like a back and the art doesn't know it", () => {
    expect(saysCardBack(true, 0.41, 0.62)).toBe(true);
    // A front the art knows fairly well is never called a back, whatever its colours.
    expect(saysCardBack(true, 0.62, 0.62)).toBe(false);
    expect(saysCardBack(true, 0.9, 0.62)).toBe(false);
    expect(saysCardBack(false, 0.2, 0.62)).toBe(false);
    expect(saysCardBack(undefined, 0.2, 0.62)).toBe(false);
  });
});
