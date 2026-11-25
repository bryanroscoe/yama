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

  it("reads the bottom right unless the caller says the left read the number", async () => {
    // No judge (no evidence yet): read, as it always was.
    const r = reader(["U 0218", "U 0218", "x"]);
    expect(await readAll(r.ocr)).toHaveLength(3);
    // The left read the number: not read.
    const told = reader(["U 0218", "U 0218", "x"]);
    expect(await readAll(told.ocr, { right: (so) => !so.some((t) => t.includes("0218")) })).toEqual(["U 0218", "U 0218"]);
    // An older frame, its number at the right end of the legal line: read.
    const old = reader(["ILLUS. CORY GODBEY", "© 201 2", "TM & © 2012 WIZARDS 59/274"]);
    expect(await readAll(old.ocr, { right: () => true })).toEqual(["ILLUS. CORY GODBEY", "© 201 2", "TM & © 2012 WIZARDS 59/274"]);
  });

  it("stops a frame at the crop the caller says is enough", async () => {
    const r = reader(["U 0218\nHOB • EN", "U 0218", "x"]);
    const asked: string[][] = [];
    const reads = await readAll(r.ocr, { done: (so) => (asked.push([...so]), so.some((t) => t.includes("HOB"))) });
    expect(reads).toEqual(["U 0218\nHOB • EN"]);
    expect(asked).toEqual([["U 0218\nHOB • EN"]]);
  });

  it("judges the bottom right by its own strip when the left corner's is turned away (review of #217)", async () => {
    // The left corner in glare, the right clear: only the right is read.
    let call = 0;
    const r = reader(["TM & © 2012 WIZARDS 59/274"]);
    const gated: StripQuality[] = [];
    const reads = await readAll(r.ocr, { gate: (q) => (gated.push(q), ++call > 1) });
    expect(reads).toEqual(["TM & © 2012 WIZARDS 59/274"]);
    expect(gated).toHaveLength(2);
    // Both turned away (a blurred card): nothing is read.
    const blurred = reader(["x"]);
    expect(await readAll(blurred.ocr, { gate: () => false })).toEqual([]);
    expect(blurred.widths).toEqual([]);
  });
});
