// Which crops of the collector line are read, in what order, and when a frame's reads stop early
// (pipeline.ts, `readCollectorLines`; Bryan, 25 Nov 2026: "we still struggle to quickly find a
// high-quality version of the card number").
import { describe, expect, it } from "vitest";
import { readCollectorLines, readsANumber } from "./pipeline";
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

async function readAll(ocr: OcrEngine, done?: (reads: readonly string[]) => boolean): Promise<string[]> {
  const reads: string[] = [];
  for await (const text of readCollectorLines(image(730, 980), quad, ocr, done ? { done } : {})) reads.push(text);
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

  it("reads the bottom right only when the left read no number", async () => {
    const numbered = reader(["U 0218\nHOB • EN CORY GODBEY", "U 0218"]);
    expect(await readAll(numbered.ocr)).toHaveLength(2);
    const none = reader(["ILLUS. CORY GODBEY", "ILLUS. CORY GODBEY", "TM & © 2007 WIZARDS 123/383"]);
    expect(await readAll(none.ocr)).toEqual(["ILLUS. CORY GODBEY", "ILLUS. CORY GODBEY", "TM & © 2007 WIZARDS 123/383"]);
  });

  it("stops a frame at the crop the caller says is enough", async () => {
    const r = reader(["U 0218\nHOB • EN", "U 0218", "x"]);
    const asked: string[][] = [];
    const reads = await readAll(r.ocr, (so) => (asked.push([...so]), so.some((t) => t.includes("HOB"))));
    expect(reads).toEqual(["U 0218\nHOB • EN"]);
    expect(asked).toEqual([["U 0218\nHOB • EN"]]);
  });
});

describe("readsANumber", () => {
  it("takes two digits or more, but not a year", () => {
    expect(readsANumber(["U 0218"])).toBe(true);
    expect(readsANumber(["C 21/281"])).toBe(true);
    expect(readsANumber(["ILLUS. CORY GODBEY"])).toBe(false);
    expect(readsANumber(["TM & © 2007 WIZARDS"])).toBe(false);
    expect(readsANumber(["1"])).toBe(false);
  });
});
