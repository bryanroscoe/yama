/// <reference types="node" />
// Real scans replayed through today's decisions (docs/scanner.md, "Scanner diagnostics"). Two
// kinds of case, both from under SCANNER_REAL_DIR (people's own photos and records stay out of
// the repository):
//
//  - Photos (real-cases.json, and SCANNER_REAL_DIR/cases.json if there is one): a kept 640 px scan
//    photo, its art scores from the phone, and the card it is. The title is read from the photo
//    and fused with those art scores (fuse.ts), as the camera does now.
//  - Scanner diagnostics records: SCANNER_REAL_DIR/<id>/record.json (get_scan_diagnostic's answer,
//    or GET /api/scan/diagnostics/<id>) with strip.jpg (and strip-last.jpg) beside it (the images
//    from the same tool or route). Replayed three ways: the frames as recorded, through the
//    evidence and the hold budgets (evidence.ts, heldRead.ts); the strip read again through
//    readCollectorLines with today's crops and reader; and the art and title the scanner had,
//    through the fusion. A record's truth is what was filed in the end (outcome filed or picked).
//
//   SCANNER_REAL_DIR=<dir> YAMA_DB=<card db> npx vitest run web/src/scanner/eval/real.test.ts
//
// Reads text with PaddleOCR as the other evals do (SCANNER_OCR=tesseract for Tesseract). Reports
// right, wrong and filed, unsettled, and frames to settle.

import jpeg from "jpeg-js";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripQuad } from "../diagnostics";
import { rectQuad } from "../image";
import { Evidence } from "../evidence";
import { fuseTitle, titleRead, type ArtCandidate } from "../fuse";
import { NameIndex } from "../fuzzy";
import { normaliseName } from "../parse";
import { readCollectorLines, readTitles } from "../pipeline";
import { replayFrames, replayLines, type DiagnosticRecord as Record } from "../replay";
import type { Quad, RgbaImage } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { DB_PATH } from "./fixtures";
import { createEvalOcr } from "./ocr";

const DIR = process.env.SCANNER_REAL_DIR;

interface PhotoCase {
  id: string;
  photo: string;
  want: { name: string };
  art?: ArtCandidate[];
}

const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};
const whole = (img: RgbaImage): Quad => [
  [0, 0],
  [img.width, 0],
  [img.width, img.height],
  [0, img.height],
];
/** Card-shaped guides centred in a photo, the whole photo first, each upright and upside down. */
function photoGuides(img: RgbaImage): Quad[] {
  const out: Quad[] = [];
  for (const fill of [1, 0.9, 0.78, 0.65]) {
    const h = Math.min(img.height * fill, img.width * fill * (88 / 63));
    const w = (h * 63) / 88;
    const q = rectQuad((img.width - w) / 2, (img.height - h) / 2, w, h);
    out.push(q, [q[2], q[3], q[0], q[1]]);
  }
  return [whole(img), ...out];
}

describe.skipIf(!DIR)("real scans, replayed", () => {
  it("replays photos and diagnostic records", { timeout: 30 * 60 * 1000 }, async () => {
    const catalog = openDbCatalog(DB_PATH);
    const names = new NameIndex(catalog.names());
    const ocr = await createEvalOcr();
    const report: string[] = [];
    const tally = { right: 0, wrongFiled: 0, unsettled: 0, unlabelled: 0, settleFrames: [] as number[] };

    // Photos: the title read now, with the art the phone had.
    const own = existsSync(join(DIR!, "cases.json")) ? (JSON.parse(readFileSync(join(DIR!, "cases.json"), "utf8")).photos as PhotoCase[]) : [];
    const photos = [...(JSON.parse(readFileSync(new URL("./real-cases.json", import.meta.url), "utf8")).photos as PhotoCase[]), ...own];
    for (const c of photos) {
      const path = join(DIR!, c.photo);
      if (!existsSync(path)) {
        report.push(`photo ${c.id}: no photo at ${c.photo}, skipped`);
        continue;
      }
      const img = decode(readFileSync(path));
      // The photo is the frame around the card, without the detector here: card-shaped guides at
      // a few sizes, as "Use a photo" tries (each snapped to the card's edges), upright and turned.
      let best: ReturnType<typeof titleRead> = null;
      for (const q of photoGuides(img)) {
        const t = titleRead(await readTitles(img, q, ocr), { names, catalog });
        if (t && (!best || t.score > best.score)) best = t;
        if (best && best.score >= 0.95) break;
      }
      const art = c.art ?? [];
      const fused = fuseTitle(art, best);
      const named = fused.kind === "art" ? fused.match.name : fused.kind === "title" ? fused.name : (art[0]?.score ?? 0) >= 0.82 ? art[0]!.name : null;
      const ok = !!named && normaliseName(named) === normaliseName(c.want.name);
      if (ok) tally.right += 1;
      else if (named) tally.wrongFiled += 1;
      else tally.unsettled += 1;
      report.push(`photo ${c.id}: title ${best ? `${best.name} (${best.score.toFixed(2)}, lead ${best.margin.toFixed(2)})` : "nothing"}; ${fused.kind}; names ${named ?? "nothing"}; ${ok ? "right" : named ? "WRONG" : "unsettled"}`);
    }

    // Diagnostic records.
    const records = readdirSync(DIR!, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(DIR!, d.name, "record.json")));
    for (const d of records) {
      const r = JSON.parse(readFileSync(join(DIR!, d.name, "record.json"), "utf8")) as Record;
      const truth = r.outcome === "filed" || r.outcome === "picked" ? (r.detail.final?.id ?? null) : null;
      const verdictOf = (id: string | null) => (!truth ? "no label" : id === truth ? "right" : id ? "WRONG" : "unsettled");
      const recorded = replayFrames(r);
      let reread: string | null = null;
      for (const strip of ["strip.jpg", "strip-last.jpg"]) {
        const p = join(DIR!, d.name, strip);
        if (!existsSync(p)) continue;
        const img = decode(readFileSync(p));
        const reads: string[] = [];
        for await (const text of readCollectorLines(img, stripQuad(img.width, img.height), ocr)) reads.push(text);
        const ev = new Evidence(replayLines(r));
        ev.add(reads);
        const v = ev.verdict();
        if (v.kind === "settled") {
          reread = v.id;
          break;
        }
      }
      const art = r.detail.scan?.art ?? [];
      const titles = r.detail.scan?.titles ?? [];
      const fused = fuseTitle(art, titleRead(titles, { names, catalog }));
      const named = fused.kind === "art" ? fused.match.name : fused.kind === "title" ? fused.name : null;
      if (!truth) tally.unlabelled += 1;
      else if (recorded.settled === truth || reread === truth) tally.right += 1;
      else if ((recorded.settled && recorded.settled !== truth) || (reread && reread !== truth)) tally.wrongFiled += 1;
      else tally.unsettled += 1;
      if (recorded.frame) tally.settleFrames.push(recorded.frame);
      report.push(
        `record ${d.name} (${r.card_name ?? "?"}, ${r.outcome}, ${(r.detail.reasons ?? []).join("+")}): recorded frames ${verdictOf(recorded.settled)}` +
          `${recorded.frame ? ` on frame ${recorded.frame} of ${recorded.frames}` : ` (${recorded.frames} frames)`}; strip read again ${verdictOf(reread)}; art and title: ${named ?? fused.kind}`,
      );
    }
    await ocr.terminate();
    catalog.close();
    const median = tally.settleFrames.length ? [...tally.settleFrames].sort((a, b) => a - b)[Math.floor(tally.settleFrames.length / 2)] : null;
    report.push(`Right ${tally.right}, wrong and filed ${tally.wrongFiled}, unsettled ${tally.unsettled}, no label ${tally.unlabelled}; frames to settle (median) ${median ?? "n/a"}.`);
    const text = report.join("\n");
    console.log(text);
    writeFileSync(join(DIR!, "replay.txt"), text + "\n");
    expect(report.length).toBeGreaterThan(0);
  });
});
