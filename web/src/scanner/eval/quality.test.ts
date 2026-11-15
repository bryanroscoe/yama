/// <reference types="node" />
// Where blur stops collector-line reads, and what the strip's sharpness is there: the numbers
// behind quality.ts's SHARP_MIN. Skipped in `npm test`; run with
//
//   SCANNER_EVAL=1 npx vitest run web/src/scanner/eval/quality.test.ts
//
// Same needs as eval.test.ts. Each test card is put in a frame 900 px tall, at a range of blurs.

import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { toGray } from "../image";
import { parseCollector } from "../parse";
import { readCollectorLines } from "../pipeline";
import { stripQuality } from "../quality";
import type { RgbaImage } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { createEvalOcr } from "./ocr";
import { DB_PATH, ensureFixtures, FIXTURES, readFixture } from "./fixtures";
import { renderScene, VARIANTS } from "./simulate";

const enabled = !!process.env.SCANNER_EVAL;
const BLURS = [0.6, 1.2, 1.8, 2.4, 3.2, 4.2];
const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};

describe.skipIf(!enabled)("strip sharpness against reads", () => {
  it("reads at each blur", { timeout: 60 * 60 * 1000 }, async () => {
    const catalog = openDbCatalog(DB_PATH);
    await ensureFixtures((f) => catalog.imageUrl(f.set, f.number));
    const ocr = await createEvalOcr();
    const cards = FIXTURES.filter((f) => f.kind === "2023+" || f.kind === "m15");
    const lines = ["| Blur σ (px) | Cards | Read | Sharpness median (min to max) |", "|---|---|---|---|"];
    let seed = 11;
    for (const blur of BLURS) {
      let ok = 0;
      const sharp: number[] = [];
      for (const f of cards) {
        const height = 900;
        const frameH = Math.round(height * 1.35);
        const frameW = Math.round(frameH * 0.75);
        const scene = renderScene(decode(readFixture(f)), { ...VARIANTS.handheld!, blur, frameW, frameH, guideFill: (height * 63) / 88 / frameW, scaleMin: 1, scaleMax: 1 }, seed++);
        sharp.push(stripQuality(toGray(scene.frame), scene.truth).sharpness);
        for await (const text of readCollectorLines(scene.frame, scene.truth, ocr)) {
          const r = parseCollector(text, (c) => catalog.hasSet(c));
          if (r.sets[0] === f.set && r.numbers.includes(f.number)) {
            ok += 1;
            break;
          }
        }
      }
      sharp.sort((a, b) => a - b);
      lines.push(`| ${blur} | ${cards.length} | ${ok} | ${Math.round(sharp[Math.floor(sharp.length / 2)]!)} (${Math.round(sharp[0]!)} to ${Math.round(sharp.at(-1)!)}) |`);
    }
    await ocr.terminate();
    catalog.close();
    console.log(lines.join("\n"));
    expect(lines.length).toBeGreaterThan(2);
  });
});
