// Each crop of the collector line is timed as it's read (pipeline.ts, `readCollectorLines`'s
// `timed`): when it went to the reader, how long the reader took, and the engine's own part.
import { describe, expect, it } from "vitest";
import { readCollectorLines, type CropTime } from "./pipeline";
import type { OcrEngine, Quad, RgbaImage } from "./types";

const image = (w: number, h: number): RgbaImage => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) });
const quad: Quad = [[50, 50], [680, 50], [680, 930], [50, 930]];

describe("readCollectorLines' timings", () => {
  it("times every crop it reads, in order, with the engine's own time where it gives one", async () => {
    let n = 0;
    const ocr: OcrEngine = { read: async () => ({ text: `crop ${++n}`, confidence: 90, ...(n % 2 ? { ms: 5 } : {}) }) };
    const times: CropTime[] = [];
    const before = Date.now();
    const reads: string[] = [];
    for await (const text of readCollectorLines(image(730, 980), quad, ocr, { timed: (t) => times.push(t) })) reads.push(text);
    expect(times).toHaveLength(reads.length);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const t of times) {
      expect(t.sentAt).toBeGreaterThanOrEqual(before);
      expect(t.ms).toBeGreaterThanOrEqual(0);
    }
    expect(times.map((t) => t.engineMs)).toEqual(times.map((_, i) => (i % 2 === 0 ? 5 : undefined)));
    // Sent one after another.
    for (let i = 1; i < times.length; i += 1) expect(times[i]!.sentAt).toBeGreaterThanOrEqual(times[i - 1]!.sentAt);
  });

  it("times nothing for a strip its gate turns away", async () => {
    const ocr: OcrEngine = { read: async () => ({ text: "x", confidence: 90 }) };
    const times: CropTime[] = [];
    for await (const _ of readCollectorLines(image(730, 980), quad, ocr, { gate: () => false, timed: (t) => times.push(t) })) void _;
    expect(times).toEqual([]);
  });
});
