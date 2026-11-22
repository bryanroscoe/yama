// The border colour read from the card's edge (border.ts; docs/plans/scanner-match-cardvision.md,
// item 24). Measured on Bryan's own scan photos and clean card pictures (docs/scanner.md, "Border
// colour"): it never said the wrong colour, and it says nothing unless the band differs from what
// lies just outside the card. These are drawn cards: a border, art inside it, a table around.
import { describe, expect, it } from "vitest";
import { byBorder, readBorder } from "./border";
import type { Quad, RgbaImage } from "./types";

type RGB = [number, number, number];

/** A card of `w` × `h` at (x, y) on a table, with a border `b` wide (as a share of its width) around noisy art. */
function cardOn(table: RGB, border: RGB, opts: { x?: number; y?: number; w?: number; b?: number; art?: (i: number, j: number) => RGB } = {}): { image: RgbaImage; quad: Quad } {
  const { x = 40, y = 40, w = 252, b = 0.035 } = opts;
  const h = Math.round((w * 88) / 63);
  const W = w + 2 * x;
  const H = h + 2 * y;
  const data = new Uint8ClampedArray(W * H * 4);
  const bw = b * w;
  const art = opts.art ?? ((i: number, j: number) => [(i * 37 + j * 11) % 255, (i * 13 + j * 71) % 255, (i * 29 + j * 5) % 255]);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const inCard = i >= x && i < x + w && j >= y && j < y + h;
      const inArt = i >= x + bw && i < x + w - bw && j >= y + bw && j < y + h - bw;
      const c = !inCard ? table : inArt ? art(i, j) : border;
      data.set([...c, 255], (j * W + i) * 4);
    }
  return { image: { width: W, height: H, data }, quad: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] };
}

const dark: RGB = [25, 30, 60];
const light: RGB = [200, 200, 195];
const black: RGB = [18, 18, 20];
const white: RGB = [238, 236, 232];

describe("reading the border colour", () => {
  it("reads a black border on a light table and a white one on a dark table", () => {
    const b = cardOn(light, black);
    expect(readBorder(b.image, b.quad).border).toBe("black");
    const w = cardOn(dark, white);
    expect(readBorder(w.image, w.quad).border).toBe("white");
  });

  it("says nothing where the border looks like the table around it (Bryan's dark mat): it may be the table", () => {
    const b = cardOn(dark, black);
    expect(readBorder(b.image, b.quad).border).toBeNull();
    const w = cardOn(light, white);
    expect(readBorder(w.image, w.quad).border).toBeNull();
  });

  it("never calls a sleeve's clear margin over the mat a black border: an outline around the sleeve sees the table", () => {
    // The outline 3% outside a white-bordered card on all sides, as around a sleeve on a dark mat.
    const w = cardOn(dark, white);
    const k = 0.03 * 252;
    const wide: Quad = [[40 - k, 40 - k], [292 + k, 40 - k], [292 + k, 40 + 352 + k], [40 - k, 40 + 352 + k]];
    expect(readBorder(w.image, wide).border).not.toBe("black");
  });

  it("never takes a coloured sleeve's margin for the card's border: further in, the card's own border shows (Codex review of #195)", () => {
    // A black sleeve's margin around a white-bordered card, on a light table, outlined at the sleeve.
    const sleeved = (table: RGB, margin: RGB, border: RGB) => {
      const w = 252;
      const m = Math.round(0.023 * w);
      const inner = cardOn(table, border, { x: 40 + m, y: 40 + m, w: w - 2 * m });
      const { image } = inner;
      const h = Math.round((w * 88) / 63);
      // Paint the margin ring between the sleeve's outline and the card.
      for (let j = 40; j < 40 + h; j++)
        for (let i = 40; i < 40 + w; i++) {
          const inCard = i >= 40 + m && i < 40 + w - m && j >= 40 + m && j < 40 + m + Math.round(((w - 2 * m) * 88) / 63);
          if (!inCard && i < image.width && j < image.height) image.data.set([...margin, 255], (j * image.width + i) * 4);
        }
      const quad: Quad = [[40, 40], [40 + w, 40], [40 + w, 40 + h], [40, 40 + h]];
      return readBorder(image, quad).border;
    };
    expect(sleeved(light, black, white)).toBeNull();
    expect(sleeved(dark, white, black)).toBeNull();
    // A black sleeve on a black-bordered card is black all the way in: still black.
    expect(sleeved(light, black, black)).toBe("black");
  });

  it("says nothing for a borderless card, whose edge is its art", () => {
    const b = cardOn(light, [0, 0, 0], { b: 0 });
    expect(readBorder(b.image, b.quad).border).toBeNull();
  });

  it("says nothing for a card partly out of the frame", () => {
    const b = cardOn(light, black, { x: 0, y: 0 });
    const out: Quad = [[-60, -60], [192, -60], [192, 292], [-60, 292]];
    expect(readBorder(b.image, out).border).toBeNull();
  });
});

describe("ruling printings out by their border", () => {
  const p = (id: string, border_color: string | null | undefined) => ({ scryfall_id: id, border_color });
  const list = [p("4ed", "white"), p("m10", "black"), p("sld", "borderless"), p("x", undefined)];

  it("a black border rules out white-bordered printings, and a white one black-bordered printings", () => {
    expect(byBorder(list, "black").map((x) => x.scryfall_id)).toEqual(["m10", "sld", "x"]);
    expect(byBorder(list, "white").map((x) => x.scryfall_id)).toEqual(["4ed", "sld", "x"]);
  });

  it("rules nothing out when unsure, or when it would rule out every printing", () => {
    expect(byBorder(list, null)).toHaveLength(4);
    expect(byBorder([p("4ed", "white")], "black").map((x) => x.scryfall_id)).toEqual(["4ed"]);
  });
});
