/// <reference types="node" />
// Spike only: how well would art-embedding retrieval do on the same simulated captures?
// Uses the MPL-2.0 ManaVault scanner bundle (cfbender/oracle models) with onnxruntime-web (MIT),
// both downloaded on demand to /tmp; neither is a dependency of the app. Run with
//
//   SCANNER_EMBED_EVAL=1 npx vitest run web/src/scanner/eval/embedding.test.ts
//
// Downloads about 50 MB (embed.onnx 5 MB, search.onnx 14 MB, arts.json 18 MB, ORT WASM 14 MB).
// Delete /tmp/yama-scanner-spike/dl afterwards.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { normaliseName } from "../parse";
import type { Quad, RgbaImage } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { DB_PATH, ensureFixtures, FIXTURES, readFixture, SPIKE_DIR } from "./fixtures";
import { renderScene, VARIANTS } from "./simulate";

const BUNDLE = "scanner-bundle-retrain-20261015T173913849634Z";
const ORT_VERSION = "1.30.0";
const DL = join(SPIKE_DIR, "dl");

async function download(url: string, path: string) {
  if (existsSync(path)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
}

const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};
const jpegRoundTrip = (img: RgbaImage, q: number): RgbaImage =>
  decode(jpeg.encode({ data: img.data, width: img.width, height: img.height }, q).data);

describe.skipIf(!process.env.SCANNER_EMBED_EVAL)("embedding retrieval (spike)", () => {
  it("ranks the right artwork first", { timeout: 60 * 60 * 1000 }, async () => {
    mkdirSync(join(DL, "ort"), { recursive: true });
    for (const f of ["embed.onnx", "search.onnx", "arts.json"]) {
      if (!existsSync(join(DL, f))) execFileSync("gh", ["release", "download", BUNDLE, "-R", "cfbender/manavault", "-p", f, "-D", DL]);
    }
    for (const f of ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
      await download(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${f}`, join(DL, "ort", f));
    }
    const ortPath: string = join(DL, "ort", "ort.wasm.min.mjs");
    const ort: any = await import(/* @vite-ignore */ ortPath);
    ort.env.wasm.wasmPaths = join(DL, "ort") + "/";
    ort.env.wasm.numThreads = 1; // a phone web view without cross-origin isolation gets one thread
    const tLoad = performance.now();
    const embed = await ort.InferenceSession.create(new Uint8Array(readFileSync(join(DL, "embed.onnx"))));
    const search = await ort.InferenceSession.create(new Uint8Array(readFileSync(join(DL, "search.onnx"))));
    const arts = JSON.parse(readFileSync(join(DL, "arts.json"), "utf8")) as { name: string; set: string; collector_number?: string }[];
    const loadMs = performance.now() - tLoad;

    const catalog = openDbCatalog(DB_PATH);
    await ensureFixtures((f) => catalog.imageUrl(f.set, f.number));
    catalog.close();

    const rows: { kind: string; variant: string; quad: string; ok: boolean; top5: boolean; score: number; margin: number; ms: number }[] = [];
    let seed = 1; // same seeds as eval.test.ts, so the scenes match
    for (const f of FIXTURES) {
      const card = decode(readFixture(f));
      const want = new Set(f.name.split(" // ").map(normaliseName).concat(normaliseName(f.name)));
      for (const v of Object.keys(VARIANTS)) {
        const scene = renderScene(card, VARIANTS[v]!, seed++, jpegRoundTrip);
        for (const q of ["guide", "truth"] as const) {
          const quad: Quad = q === "truth" ? scene.truth : scene.guide;
          const t0 = performance.now();
          const sceneT = new ort.Tensor("uint8", new Uint8Array(scene.frame.data.buffer), [scene.frame.height, scene.frame.width, 4]);
          const quadT = new ort.Tensor("float32", Float32Array.from(quad.flat()), [4, 2]);
          const { embeddings } = await embed.run({ scene: sceneT, quad: quadT });
          const { indices, scores } = await search.run({ embeddings });
          const ms = performance.now() - t0;
          const idx = Array.from(indices.data as BigInt64Array, Number);
          const sc = Array.from(scores.data as Float32Array);
          const names = idx.map((i) => normaliseName(arts[i]!.name));
          const hit = (n: string) => want.has(n);
          rows.push({ kind: f.kind, variant: v, quad: q, ok: hit(names[0]!), top5: names.some(hit), score: sc[0]!, margin: sc[0]! - sc[1]!, ms });
          if (!hit(names[0]!)) console.log(`MISS ${f.set}-${f.number} [${v}/${q}] -> ${arts[idx[0]!]!.name} (${sc[0]!.toFixed(3)})`);
        }
      }
    }
    const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
    const lines = [`Loaded embed+search+arts in ${loadMs.toFixed(0)} ms (${arts.length} arts).`, "", "| Quad | Variant | Scans | Top-1 card | Top-5 card | Median ms |", "|---|---|---|---|---|---|"];
    for (const q of ["guide", "truth"]) {
      for (const v of [...Object.keys(VARIANTS), "all"]) {
        const rs = rows.filter((r) => r.quad === q && (v === "all" || r.variant === v));
        lines.push(`| ${q} | ${v} | ${rs.length} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${pct(rs.filter((r) => r.top5).length, rs.length)} | ${med(rs.map((r) => r.ms)).toFixed(0)} |`);
      }
    }
    lines.push("", "| Quad | Frame kind | Scans | Top-1 card |", "|---|---|---|---|");
    for (const q of ["guide", "truth"]) {
      for (const k of ["2023+", "m15", "dfc", "fullart", "2003", "old"]) {
        const rs = rows.filter((r) => r.quad === q && r.kind === k);
        lines.push(`| ${q} | ${k} | ${rs.length} | ${pct(rs.filter((r) => r.ok).length, rs.length)} |`);
      }
    }
    const report = lines.join("\n");
    console.log(report);
    writeFileSync(join(SPIKE_DIR, "embedding-results.md"), report + "\n");
    writeFileSync(join(SPIKE_DIR, "embedding-results.json"), JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
  });
});
