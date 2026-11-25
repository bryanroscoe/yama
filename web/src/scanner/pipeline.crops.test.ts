// Which crops of the collector line are read, in what order, and when a frame's reads stop early
// (pipeline.ts, `readCollectorLines`; Bryan, 25 Nov 2026: "we still struggle to quickly find a
// high-quality version of the card number").
import { describe, expect, it } from "vitest";
import { readCollectorLines } from "./pipeline";
import type { StripQuality } from "./quality";
import type { Gray, OcrEngine, Quad, RgbaImage } from "./types";

const image = (w: number, h: number): RgbaImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) });
const quad: Quad = [[50, 50], [680, 50], [680, 930], [50, 930]];

/** A reader that answers each crop in turn with `texts` (then nothing), noting each crop's width. */
function reader(texts: string[]): { ocr: OcrEngine; widths: number[] } {
  const widths: number[] = [];
  return {
    widths,
    ocr: {
      read: async (img: Gray) => {
        widths.push(img.width);
        return { text: texts[widths.length - 1] ?? "", confidence: 90 };
      },
    },
  };
}

async function readAll(ocr: OcrEngine, opts: Parameters<typeof readCollectorLines>[3] = {}): Promise<string[]> {
  const reads: string[] = [];
  for await (const text of readCollectorLines(image(730, 980), quad, ocr, opts)) reads.push(text);
  return reads;
}

describe("the collector line's crops", () => {
  it("reads the wide cut first, then the usual corner", async () => {
    const r = reader(["U 0218", "U 0218"]);
    await readAll(r.ocr);
    // The wide cut is the wider of the two (0.61 of the card's width against 0.47).
    expect(r.widths.length).toBeGreaterThanOrEqual(2);
    expect(r.widths[0]!).toBeGreaterThan(r.widths[1]!);
  });

  it("reads the bottom right whenever the frame wasn't settled on the left", async () => {
    const r = reader(["U 0218", "U 0218", "x"]);
    expect(await readAll(r.ocr)).toHaveLength(3);
    // The left read a number, but the caller's evidence isn't settled: the right is read too.
    const unsettled = reader(["U 0218", "U 0218", "x"]);
    expect(await readAll(unsettled.ocr, { done: () => false })).toEqual(["U 0218", "U 0218", "x"]);
  });

  it("stops a frame at the crop the caller says is enough", async () => {
    const r = reader(["U 0218\nHOB • EN", "U 0218", "x"]);
    const asked: string[][] = [];
    const reads = await readAll(r.ocr, { done: (so) => (asked.push([...so]), so.some((t) => t.includes("HOB"))) });
    expect(reads).toEqual(["U 0218\nHOB • EN"]);
    expect(asked).toEqual([["U 0218\nHOB • EN"]]);
  });

  it("judges the bottom right by its own strip when the left corner's is turned away (review of #217)", async () => {
    // The card's bottom left blank (a corner in glare reads flat), its bottom right printed: the
    // gate measures each strip from the image itself.
    const img = image(730, 980);
    for (let y = 842; y < 922; y += 1) for (let x = 370; x < 660; x += 1) if (x % 6 < 3) img.data.fill(20, (y * 730 + x) * 4, (y * 730 + x) * 4 + 3);
    const sharp = (q: StripQuality) => q.sharpness > 50;
    const r = reader(["TM & © 2012 WIZARDS 59/274"]);
    const gated: number[] = [];
    const reads: string[] = [];
    for await (const text of readCollectorLines(img, quad, r.ocr, { gate: (q) => (gated.push(Math.round(q.sharpness)), sharp(q)) })) reads.push(text);
    expect(reads).toEqual(["TM & © 2012 WIZARDS 59/274"]);
    expect(gated).toHaveLength(2);
    expect(gated[0]).toBeLessThan(50);
    expect(gated[1]).toBeGreaterThan(50);
    // Both turned away (a blurred card): nothing is read.
    const blurred = reader(["x"]);
    expect(await readAll(blurred.ocr, { gate: () => false })).toEqual([]);
    expect(blurred.widths).toEqual([]);
  });
});
