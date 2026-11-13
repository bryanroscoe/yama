/// <reference types="node" />
// The close-up step on simulated close-ups: the collector line or the title cut from each eval
// card, slightly rotated and blurred with sensor noise, read the way ScannerView reads its box.
// Skipped in `npm test`; run with
//
//   SCANNER_EVAL=1 YAMA_DB=../yama/data/yama.db npx vitest run web/src/scanner/eval/closeup.test.ts
//
// The printing is chosen among all of the card's printings in the database (as when Yama has no
// illustration IDs yet), which is harder than among the printings that share the art.

import jpeg from "jpeg-js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Printing } from "../../api";
import { NameIndex } from "../fuzzy";
import { rectQuad, warpRegionRgba } from "../image";
import { normaliseName } from "../parse";
import { COLLECTOR_REGION, NAME_REGION, readCloseup } from "../pipeline";
import { choosePrinting } from "../printings";
import type { Point, Quad, RgbaImage } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { createEvalOcr } from "./ocr";
import { DB_PATH, ensureFixtures, FIXTURES, readFixture, SPIKE_DIR } from "./fixtures";
import { rng } from "./simulate";

const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};

/** The region of the card, as a phone held close would see it: a little turned, soft and noisy. */
function closeup(card: RgbaImage, region: { x0: number; y0: number; x1: number; y1: number }, height: number, seed: number): RgbaImage {
  const rand = rng(seed);
  const w = card.width;
  const h = card.height;
  // A box a bit larger than the region (people don't frame it exactly), turned up to 3 degrees.
  const pad = 0.08;
  const r = { x0: Math.max(0, region.x0 - pad * (region.x1 - region.x0)), x1: Math.min(1, region.x1 + pad * (region.x1 - region.x0)), y0: Math.max(0, region.y0 - 0.3 * (region.y1 - region.y0)), y1: Math.min(1, region.y1 + 0.3 * (region.y1 - region.y0)) };
  const a = ((rand() * 2 - 1) * 3 * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const turn = ([x, y]: Point): Point => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
  const quad = rectQuad(0, 0, w, h).map(turn) as Quad;
  const outH = height;
  const outW = Math.round((outH * ((r.x1 - r.x0) * 63)) / ((r.y1 - r.y0) * 88));
  const img = warpRegionRgba(card, quad, r, outW, outH);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 16;
    for (let c = 0; c < 3; c += 1) img.data[i + c] = img.data[i + c]! * 0.85 + n;
  }
  return img;
}

describe.skipIf(!process.env.SCANNER_EVAL)("close-up step (simulated)", () => {
  it("settles the printing and the name", { timeout: 30 * 60 * 1000 }, async () => {
    const catalog = openDbCatalog(DB_PATH);
    await ensureFixtures((f) => catalog.imageUrl(f.set, f.number));
    const ocr = await createEvalOcr();
    const names = new NameIndex(catalog.names());
    const lines: string[] = ["| Card | Kind | Collector read | Printing | Title read | Name |", "|---|---|---|---|---|---|"];
    let printingsRight = 0;
    let printingsWrong = 0;
    let printingsAsked = 0;
    let namesRight = 0;
    let seed = 7;
    for (const f of FIXTURES) {
      const card = decode(readFixture(f));
      const all = (await catalog.printingsOf!(f.name)).map((p) => ({ scryfall_id: p.scryfall_id ?? "", name: p.name, set_code: p.set, set_name: p.set, collector_number: p.number, lang: p.lang }) as Printing);
      const text = await readCloseup(closeup(card, COLLECTOR_REGION, 200, seed++), "collector", ocr);
      const c = choosePrinting({ sameArt: false, printings: all }, text);
      const right = c.chosen && c.chosen.set_code === f.set && c.chosen.collector_number === f.number;
      if (right) printingsRight += 1;
      else if (c.chosen) printingsWrong += 1;
      else printingsAsked += 1;
      const titleImage = closeup(card, NAME_REGION, 110, seed++);
      if (process.env.SCANNER_DEBUG) writeFileSync(join(SPIKE_DIR, `closeup-title-${f.set}-${f.number}.jpg`), jpeg.encode({ data: titleImage.data, width: titleImage.width, height: titleImage.height }, 90).data);
      const title = await readCloseup(titleImage, "title", ocr);
      const [top] = names.match(title, 2);
      const name = top ? (catalog.fullName?.(top.name) ?? top.name) : "";
      const nameOk = !!top && top.score >= 0.8 && normaliseName(name) === normaliseName(f.name);
      if (nameOk) namesRight += 1;
      lines.push(`| ${f.set}-${f.number} | ${f.kind} | ${text.replace(/\s+/g, " ")} | ${right ? "right" : c.chosen ? `WRONG ${c.chosen.set_code} ${c.chosen.collector_number}` : "asks"} | ${title.replace(/\s+/g, " ")} | ${nameOk ? "right" : name || "none"} |`);
    }
    await ocr.terminate();
    catalog.close();
    lines.unshift(`Printings: ${printingsRight} right, ${printingsWrong} wrong, ${printingsAsked} left to pick, of ${FIXTURES.length}. Names: ${namesRight} of ${FIXTURES.length}.`, "");
    const report = lines.join("\n");
    console.log(report);
    writeFileSync(join(SPIKE_DIR, "closeup-results.md"), report + "\n");
    expect(printingsWrong).toBe(0);
  });
});
