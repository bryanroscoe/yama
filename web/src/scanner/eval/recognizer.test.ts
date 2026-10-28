/// <reference types="node" />
// Art recognition on simulated free-hand captures (no guide to line up with). Skipped in
// `npm test`; run with
//
//   SCANNER_RECOGNIZER_EVAL=1 YAMA_DB=../yama/data/yama.db npx vitest run web/src/scanner/eval/recognizer.test.ts
//
// Needs the scanner bundle unpacked in SCANNER_BUNDLE_DIR (default /tmp/yama-scan-bundle: the
// server's data/scan-bundle/<version> works) and the fixtures eval.test.ts uses.

import jpeg from "jpeg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normaliseName } from "../parse";
import { createRecognizer, parseArts, type OrtLike } from "../recognizer";
import type { Point, Quad, RgbaImage } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { DB_PATH, ensureFixtures, FIXTURES, readFixture, SPIKE_DIR } from "./fixtures";
import { FREEHAND, renderScene, VARIANTS } from "./simulate";

const BUNDLE = process.env.SCANNER_BUNDLE_DIR ?? "/tmp/yama-scan-bundle";
/** The app hands the recognizer frames with this short side. */
const SHORT = 640;

const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};
const jpegRoundTrip = (img: RgbaImage, q: number): RgbaImage => decode(jpeg.encode({ data: img.data, width: img.width, height: img.height }, q).data);

/** Box-filter downscale, as a canvas drawImage roughly does. */
function shrink(img: RgbaImage, k: number): RgbaImage {
  const w = Math.round(img.width * k);
  const h = Math.round(img.height * k);
  const out = new Uint8ClampedArray(w * h * 4);
  const step = 1 / k;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = Math.floor(y * step); sy < Math.min(img.height, Math.floor((y + 1) * step)); sy += 1) {
        for (let sx = Math.floor(x * step); sx < Math.min(img.width, Math.floor((x + 1) * step)); sx += 1) {
          const o = (sy * img.width + sx) * 4;
          r += img.data[o]!;
          g += img.data[o + 1]!;
          b += img.data[o + 2]!;
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

const cornerError = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1])));

describe.skipIf(!process.env.SCANNER_RECOGNIZER_EVAL)("art recognizer (simulated free-hand captures)", () => {
  it("finds and names the card", { timeout: 60 * 60 * 1000 }, async () => {
    const ort = (await import("onnxruntime-web")) as unknown as OrtLike & { env: { wasm: { numThreads: number } } };
    ort.env.wasm.numThreads = 1; // a phone web view without cross-origin isolation gets one thread
    const read = (f: string) => new Uint8Array(readFileSync(join(BUNDLE, f)));
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
    const arts = parseArts(JSON.parse(readFileSync(join(BUNDLE, "arts.json"), "utf8")));
    const t0 = performance.now();
    const recognizer = await createRecognizer(ort, { detector: read("detector.onnx"), embed: read("embed.onnx"), search: read("search.onnx") }, manifest.constants, arts);
    const loadMs = performance.now() - t0;

    const catalog = openDbCatalog(DB_PATH);
    await ensureFixtures((f) => catalog.imageUrl(f.set, f.number));
    catalog.close();

    const variants = { ...FREEHAND, "steady (guide)": VARIANTS.steady!, "far (guide)": VARIANTS["far (720p-like)"]! };
    const rows: { variant: string; kind: string; found: boolean; ok: boolean; score: number; margin: number; err: number; ms: number }[] = [];
    const misses: string[] = [];
    let seed = 1000;
    for (const f of FIXTURES) {
      const card = decode(readFixture(f));
      const want = new Set([normaliseName(f.name), ...f.name.split(" // ").map(normaliseName)]);
      for (const [v, params] of Object.entries(variants)) {
        const scene = renderScene(card, params, seed++, jpegRoundTrip);
        const k = SHORT / Math.min(scene.frame.width, scene.frame.height);
        const frame = shrink(scene.frame, k);
        recognizer.reset();
        const r = await recognizer.identify(frame);
        const top = r.matches[0];
        const ok = !!top && want.has(normaliseName(top.name));
        const truth = scene.truth.map(([x, y]) => [x * k, y * k] as Point) as Quad;
        const err = r.quad ? cornerError(r.quad, truth) / Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]) : NaN;
        rows.push({ variant: v, kind: f.kind, found: !!r.quad, ok, score: top?.score ?? 0, margin: (top?.score ?? 0) - (r.matches[1]?.score ?? 0), err, ms: r.timings.totalMs });
        if (!ok) misses.push(`MISS ${f.set}-${f.number} [${v}] -> ${top ? `${top.name} ${top.score.toFixed(3)}` : "no card"} (up ${r.upright.toFixed(2)})`);
      }
    }
    const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
    const med = (xs: number[]) => [...xs].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
    const lines = [`Loaded in ${loadMs.toFixed(0)} ms (${arts.length} arts).`, "", "| Variant | Scans | Card found | Right card | Wrong with score ≥ 0.8 | Median corner error | Median ms |", "|---|---|---|---|---|---|---|"];
    for (const v of [...Object.keys(variants), "all"]) {
      const rs = rows.filter((r) => v === "all" || r.variant === v);
      lines.push(`| ${v} | ${rs.length} | ${pct(rs.filter((r) => r.found).length, rs.length)} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${rs.filter((r) => !r.ok && r.score >= 0.8).length} | ${(100 * med(rs.map((r) => r.err))).toFixed(1)}% | ${med(rs.map((r) => r.ms)).toFixed(0)} |`);
    }
    const right = rows.filter((r) => r.ok).map((r) => r.score);
    const wrong = rows.filter((r) => !r.ok && r.found).map((r) => r.score);
    lines.push("", `Right answers scored ${Math.min(...right).toFixed(2)} to ${Math.max(...right).toFixed(2)} (median ${med(right).toFixed(2)}); wrong ones at most ${wrong.length ? Math.max(...wrong).toFixed(2) : "n/a"}.`);
    lines.push("", ...misses.map((m) => `- ${m}`));
    const report = lines.join("\n");
    console.log(report);
    writeFileSync(join(SPIKE_DIR, "recognizer-results.md"), report + "\n");
    expect(rows.length).toBeGreaterThan(0);
  });
});
