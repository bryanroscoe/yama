/// <reference types="node" />
// Scanner accuracy and latency on simulated phone captures. Skipped in `npm test`; run with
//
//   SCANNER_EVAL=1 npx vitest run web/src/scanner/eval
//
// Needs the server's card database (data/yama.db) and network on the first run to fetch ~26 card
// images (about 4 MB) and Tesseract's English model (3 MB) into /tmp/yama-scanner-spike.
// Options: SCANNER_EVAL_QUADS=refined,guide,truth  SCANNER_EVAL_VARIANTS=steady,rough
//          SCANNER_EVAL_CARDS=mom-214,4ed-103  SCANNER_DEBUG=1 (writes crops to /tmp)

import jpeg from "jpeg-js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NameIndex } from "../fuzzy";
import { scanFrame } from "../pipeline";
import { createTesseractOcr } from "../tesseract";
import type { Quad, RgbaImage } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { DB_PATH, ensureFixtures, FIXTURES, readFixture, SPIKE_DIR, type Fixture } from "./fixtures";
import { renderScene, VARIANTS } from "./simulate";

const enabled = !!process.env.SCANNER_EVAL;
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()) : null);

const jpegRoundTrip = (img: RgbaImage, q: number): RgbaImage => {
  const enc = jpeg.encode({ data: img.data, width: img.width, height: img.height }, q);
  const dec = jpeg.decode(enc.data, { useTArray: true, formatAsRGBA: true });
  return { width: dec.width, height: dec.height, data: new Uint8ClampedArray(dec.data.buffer) };
};

const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};

function cornerError(a: Quad, b: Quad): number {
  let worst = 0;
  for (let i = 0; i < 4; i += 1) worst = Math.max(worst, Math.hypot(a[i]![0] - b[i]![0], a[i]![1] - b[i]![1]));
  return worst;
}

interface Row {
  card: string;
  kind: Fixture["kind"];
  variant: string;
  quad: string;
  cardOk: boolean;
  printingOk: boolean;
  confident: boolean;
  method: string;
  ms: number;
  cornerErr: number;
  raw: string;
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};

describe.skipIf(!enabled)("scanner eval", () => {
  it("recognises simulated captures", { timeout: 60 * 60 * 1000 }, async () => {
    const catalog = openDbCatalog(DB_PATH);
    await ensureFixtures((f) => catalog.imageUrl(f.set, f.number));
    const t0 = performance.now();
    const names = new NameIndex(catalog.names());
    const indexMs = performance.now() - t0;
    const langDir = join(SPIKE_DIR, "lang");
    const ocr = await createTesseractOcr(existsSync(join(langDir, "eng.traineddata.gz")) ? { langPath: langDir, cachePath: langDir } : { cachePath: langDir });
    const quads = list(process.env.SCANNER_EVAL_QUADS) ?? ["refined"];
    const variants = list(process.env.SCANNER_EVAL_VARIANTS) ?? Object.keys(VARIANTS);
    const only = list(process.env.SCANNER_EVAL_CARDS);
    const debugDir = process.env.SCANNER_DEBUG ? join(SPIKE_DIR, "debug") : null;
    if (debugDir) mkdirSync(debugDir, { recursive: true });

    const rows: Row[] = [];
    let seed = 1;
    for (const f of FIXTURES) {
      const id = `${f.set}-${f.number}`;
      if (only && !only.includes(id)) continue;
      const card = decode(readFixture(f));
      for (const v of variants) {
        const scene = renderScene(card, VARIANTS[v]!, seed++, jpegRoundTrip);
        if (debugDir) writeFileSync(join(debugDir, `${id}-${v.replace(/\W+/g, "_")}.jpg`), jpeg.encode({ data: scene.frame.data, width: scene.frame.width, height: scene.frame.height }, 80).data);
        for (const q of quads) {
          const res = await scanFrame(scene.frame, {
            ocr,
            catalog,
            names,
            guide: q === "truth" ? scene.truth : scene.guide,
            refine: q === "refined",
          });
          const best = res.candidates[0];
          const cardOk = !!best && best.name === f.name;
          const printingOk = !!best && best.set === f.set && best.number === f.number;
          rows.push({
            card: id,
            kind: f.kind,
            variant: v,
            quad: q,
            cardOk,
            printingOk,
            confident: !!best && best.confidence >= 0.8,
            method: best?.method ?? "none",
            ms: res.timings.totalMs,
            cornerErr: cornerError(res.quad, scene.truth) / (scene.guide[1][0] - scene.guide[0][0]),
            raw: `${res.raw.collector.replace(/\n/g, " | ")} || ${res.raw.name}`,
          });
          const r = rows[rows.length - 1]!;
          if (!r.cardOk || process.env.SCANNER_VERBOSE)
            console.log(`${r.cardOk ? "ok  " : "MISS"} ${id} [${v}/${q}] -> ${best ? `${best.name} ${best.set ?? ""} ${best.number ?? ""} (${best.method} ${best.confidence.toFixed(2)})` : "nothing"}  raw: ${r.raw}`);
        }
      }
    }
    await ocr.terminate();
    catalog.close();

    // Summary tables (markdown) for docs/scanner.md.
    const lines: string[] = [];
    lines.push(`Name index: ${names.size} names, built in ${indexMs.toFixed(0)} ms.`, "");
    lines.push("| Quad | Variant | Scans | Card right | Printing right | Confident and wrong | Median ms | p90 ms | Median corner error |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const q of quads) {
      for (const v of [...variants, "all"]) {
        const rs = rows.filter((r) => r.quad === q && (v === "all" || r.variant === v));
        const withNumber = rs.filter((r) => r.kind !== "2003" && r.kind !== "old");
        lines.push(
          `| ${q} | ${v} | ${rs.length} | ${pct(rs.filter((r) => r.cardOk).length, rs.length)} | ${pct(withNumber.filter((r) => r.printingOk).length, withNumber.length)} | ${rs.filter((r) => r.confident && !r.cardOk).length} | ${quantile(rs.map((r) => r.ms), 0.5).toFixed(0)} | ${quantile(rs.map((r) => r.ms), 0.9).toFixed(0)} | ${(100 * quantile(rs.map((r) => r.cornerErr), 0.5)).toFixed(1)}% |`,
        );
      }
    }
    lines.push("", "| Quad | Frame kind | Scans | Card right | Printing right | Via collector line |", "|---|---|---|---|---|---|");
    for (const q of quads) {
      for (const k of ["2023+", "m15", "dfc", "fullart", "2003", "old"] as const) {
        const rs = rows.filter((r) => r.quad === q && r.kind === k);
        if (rs.length === 0) continue;
        lines.push(
          `| ${q} | ${k} | ${rs.length} | ${pct(rs.filter((r) => r.cardOk).length, rs.length)} | ${k === "2003" || k === "old" ? "n/a" : pct(rs.filter((r) => r.printingOk).length, rs.length)} | ${pct(rs.filter((r) => r.method.startsWith("collector")).length, rs.length)} |`,
        );
      }
    }
    const report = lines.join("\n");
    console.log(report);
    writeFileSync(join(SPIKE_DIR, "results.md"), report + "\n");
    writeFileSync(join(SPIKE_DIR, "results.json"), JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  });
});
