/// <reference types="node" />
// The artwork supplement (server/src/scan_art.rs): are vectors Yama embeds from Scryfall's art
// crops as good as the bundle's own? Held out: the bundle (gallery-20261106) already knows Star
// Trek, so this hides the bundle's rows for artworks the supplement re-embedded (the search
// graph's mask, `createRecognizer`'s `hidden`) and finds the cards through the supplement instead.
// Skipped in `npm test`; run with
//
//   SCANNER_SUPPLEMENT_EVAL=1 SCANNER_BUNDLE_DIR=<bundle with arts.json> \
//     SCANNER_SUPPLEMENT=<supplement-….json from `yama-server scan-arts --include-known --out DIR`> \
//     SCANNER_EVAL_CARDS=<Scryfall card objects (JSON array) with the eval cards' image URLs> \
//     npx vitest run web/src/scanner/eval/supplement.test.ts
//
// Card images are downloaded from Scryfall into SCANNER_SPIKE_DIR (default /tmp; never committed).

import jpeg from "jpeg-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGallery } from "../gallery";
import { normaliseName } from "../parse";
import { createRecognizer, parseArts, parseSupplement, type OrtLike } from "../recognizer";
import type { RgbaImage } from "../types";
import { FIXTURES, SPIKE_DIR } from "./fixtures";
import { FREEHAND, renderScene, VARIANTS } from "./simulate";

const BUNDLE = process.env.SCANNER_BUNDLE_DIR ?? "/tmp/yama-scan-bundle";
const SHORT = 640;

/** Star Trek and Star Trek Commander cards Bryan owns (picked from his collection, 15 Nov 2026). */
const TREK = [
  ["trk", "12", "DOT-7 Repair Squad"],
  ["trk", "26", "Oberth-Class Starship"],
  ["trk", "42", "Una Chin-Riley, Number One"],
  ["trk", "60", "Guidance Failure"],
  ["trk", "78", "Rules of Acquisition"],
  ["trk", "90", "Zefram Cochrane, Warp Pioneer"],
  ["trk", "105", "Eject the Warp Core"],
  ["trk", "123", "Pattern Buffer Preservation"],
  ["trk", "130", "Stray from History"],
  ["trk", "143", "Captain Michael Burnham"],
  ["trk", "156", "La'An Noonien-Singh, Security"],
  ["trk", "170", "Sarcophagus, Ship of the Dead"],
  ["trk", "184", "Astute Terraformer"],
  ["trk", "217", "Sylvia Tilly, Joy of Discovery"],
  ["trk", "236", "D'Vana Tendi, Optimistic Ensign"],
  ["trk", "247", "L'Rell, Fierce Visionary"],
  ["trk", "270", "Tricorder"],
  ["trk", "286", "Hallowed Fountain"],
  ["trk", "299", "Stomping Ground"],
  ["trc", "424", "Loran of the Third Path"],
  ["trc", "572", "Training Center"],
] as const;

const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};
const jpegRoundTrip = (img: RgbaImage, q: number): RgbaImage => decode(jpeg.encode({ data: img.data, width: img.width, height: img.height }, q).data);

/** Box-filter downscale (recognizer.test.ts). */
function shrink(img: RgbaImage, k: number): RgbaImage {
  const w = Math.round(img.width * k);
  const h = Math.round(img.height * k);
  const out = new Uint8ClampedArray(w * h * 4);
  const step = 1 / k;
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = Math.floor(y * step); sy < Math.min(img.height, Math.floor((y + 1) * step)); sy += 1)
        for (let sx = Math.floor(x * step); sx < Math.min(img.width, Math.floor((x + 1) * step)); sx += 1) {
          const o = (sy * img.width + sx) * 4;
          r += img.data[o]!;
          g += img.data[o + 1]!;
          b += img.data[o + 2]!;
          n += 1;
        }
      const o = (y * w + x) * 4;
      out.set([r / n, g / n, b / n, 255], o);
    }
  return { width: w, height: h, data: out };
}

interface SupplementFile {
  bundle: string;
  dim: number;
  columns: string[];
  rows: unknown[][];
  frames: number[];
  penalties: number[];
  vectors: string;
}

/** The supplement's rows that pass `keep`, as a file of its own. */
function subset(s: SupplementFile, keep: (row: unknown[]) => boolean): SupplementFile {
  const bytes = Buffer.from(s.vectors, "base64");
  const idx = s.rows.map((r, i) => (keep(r) ? i : -1)).filter((i) => i >= 0);
  const vec = Buffer.concat(idx.map((i) => bytes.subarray(i * s.dim * 2, (i + 1) * s.dim * 2)));
  return { ...s, rows: idx.map((i) => s.rows[i]!), frames: idx.map((i) => s.frames[i]!), penalties: idx.map((i) => s.penalties[i]!), vectors: vec.toString("base64") };
}

describe.skipIf(!process.env.SCANNER_SUPPLEMENT_EVAL)("artwork supplement (held out from the bundle)", () => {
  it("embeds like the bundle and finds held-out cards through the supplement", { timeout: 2 * 60 * 60 * 1000 }, async () => {
    const ort = (await import("onnxruntime-web")) as unknown as OrtLike & { env: { wasm: { numThreads: number } } };
    ort.env.wasm.numThreads = 1;
    const read = (f: string) => new Uint8Array(readFileSync(join(BUNDLE, f)));
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
    const rawArts = JSON.parse(readFileSync(join(BUNDLE, "arts.json"), "utf8")) as { illustration_id?: string; frame?: string }[];
    const arts = parseArts(rawArts);
    const graphs = { detector: read("detector.onnx"), embed: read("embed.onnx"), search: read("search.onnx") };
    const file = JSON.parse(readFileSync(process.env.SCANNER_SUPPLEMENT!, "utf8")) as SupplementFile;
    const version = manifest.version as string;
    expect(file.bundle).toBe(version);

    // 1. The vectors against the bundle's own rows for the same artworks.
    const gallery = readGallery(graphs.search);
    const byIll = new Map<string, number>();
    arts.forEach((a, i) => a.illustrationId && !byIll.has(a.illustrationId) && byIll.set(a.illustrationId, i));
    const full = parseSupplement(file, version);
    const frameNames = manifest.constants.frame_names as string[];
    const cosines: number[] = [];
    let frameAgree = 0;
    let compared = 0;
    const worst: string[] = [];
    full.arts.forEach((a, i) => {
      const row = a.illustrationId ? byIll.get(a.illustrationId) : undefined;
      if (row === undefined) return;
      const ours = full.gallery.row(i);
      const theirs = gallery.row(row);
      let dot = 0;
      for (let j = 0; j < file.dim; j += 1) dot += ours[j]! * theirs[j]!;
      cosines.push(dot);
      compared += 1;
      if (frameNames[file.frames[i]!] === rawArts[row]!.frame) frameAgree += 1;
      else worst.push(`frame ${a.set}-${a.number} ${a.name}: ours ${frameNames[file.frames[i]!]}, bundle ${rawArts[row]!.frame}`);
      if (dot < 0.97) worst.push(`cosine ${dot.toFixed(4)} ${a.set}-${a.number} ${a.name}`);
    });
    const sorted = [...cosines].sort((x, y) => x - y);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

    // 2. Recognition, three ways.
    const scry = JSON.parse(readFileSync(process.env.SCANNER_EVAL_CARDS!, "utf8")) as { set: string; collector_number: string; image_uris?: { large?: string }; card_faces?: { image_uris?: { large?: string } }[] }[];
    const imageUrl = (set: string, number: string) => {
      const c = scry.find((x) => x.set === set && x.collector_number === number);
      return c?.image_uris?.large ?? c?.card_faces?.[0]?.image_uris?.large ?? null;
    };
    const dir = join(SPIKE_DIR, "supplement-cards");
    mkdirSync(dir, { recursive: true });
    const cards = [...TREK.map(([set, number, name]) => ({ set, number, name, group: "trek" })), ...FIXTURES.map((f) => ({ set: f.set, number: f.number, name: f.name, group: "eval" }))];
    for (const c of cards) {
      const path = join(dir, `${c.set}-${c.number}.jpg`);
      if (existsSync(path)) continue;
      const url = imageUrl(c.set, c.number);
      if (!url) throw new Error(`no image for ${c.set} ${c.number}`);
      const res = await fetch(url, { headers: { "User-Agent": "YamaScannerEval/0.1 (scanner art eval)", Accept: "image/jpeg" } });
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
      await new Promise((r) => setTimeout(r, 120));
    }

    const trekRows = (r: unknown[]) => r[2] === "trk" || r[2] === "trc";
    const trekIlls = new Set(file.rows.filter(trekRows).map((r) => r[4] as string));
    const allIlls = new Set(file.rows.map((r) => r[4] as string));
    const rowsOf = (ills: Set<string>) => arts.flatMap((a, i) => (a.illustrationId && ills.has(a.illustrationId) ? [i] : []));
    const configs = [
      { name: "bundle alone (baseline)", supplement: null, hidden: [] as number[] },
      { name: "Star Trek hidden from the bundle, found through the supplement", supplement: subset(file, trekRows), hidden: rowsOf(trekIlls) },
      { name: "Star Trek and the eval cards hidden, found through the supplement", supplement: file, hidden: rowsOf(allIlls) },
    ];
    const variants = { ...FREEHAND, "steady (guide)": VARIANTS.steady!, "far (guide)": VARIANTS["far (720p-like)"]! };
    const lines = [
      `Supplement: ${file.rows.length} rows for bundle ${version}; ${compared} of them are artworks the bundle has.`,
      `Cosine with the bundle's own row: min ${sorted[0]!.toFixed(4)}, 1st percentile ${q(0.01).toFixed(4)}, median ${q(0.5).toFixed(4)}. Same frame as the bundle: ${frameAgree} of ${compared}.`,
      "",
      "| Setup | Bundle rows hidden | Cards | Scans | Card found | Right card | Right, through the supplement | Wrong, score ≥ 0.62 | Wrong, score ≥ 0.8 | Right scores (min / median) | Median ms |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    ];
    const misses: string[] = [];
    for (const cfg of configs) {
      const t0 = performance.now();
      const supplement = cfg.supplement ? parseSupplement(cfg.supplement, version) : null;
      const recognizer = await createRecognizer(ort, graphs, manifest.constants, arts, supplement, { hidden: cfg.hidden });
      const loadMs = performance.now() - t0;
      const rows: { group: string; found: boolean; ok: boolean; extra: boolean; score: number; ms: number }[] = [];
      let seed = 7000;
      for (const c of cards) {
        const card = decode(new Uint8Array(readFileSync(join(dir, `${c.set}-${c.number}.jpg`))));
        const want = new Set([normaliseName(c.name), ...c.name.split(" // ").map(normaliseName)]);
        for (const [v, params] of Object.entries(variants)) {
          const scene = renderScene(card, params, seed++, jpegRoundTrip);
          const k = SHORT / Math.min(scene.frame.width, scene.frame.height);
          recognizer.reset();
          const r = await recognizer.identify(shrink(scene.frame, k));
          const top = r.matches[0];
          const ok = !!top && want.has(normaliseName(top.name));
          rows.push({ group: c.group, found: !!r.quad, ok, extra: !!top && top.index >= arts.length, score: top?.score ?? 0, ms: r.timings.totalMs });
          if (!ok && cfg.supplement) misses.push(`${cfg.name.split(",")[0]}: ${c.set}-${c.number} [${v}] -> ${top ? `${top.name} (${top.set}) ${top.score.toFixed(3)}` : "no card"}`);
        }
      }
      const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
      for (const group of ["trek", "eval"]) {
        const rs = rows.filter((r) => r.group === group);
        const right = rs.filter((r) => r.ok).map((r) => r.score);
        lines.push(
          `| ${cfg.name} | ${cfg.hidden.length} | ${group === "trek" ? "21 Star Trek" : "26 eval cards"} | ${rs.length} | ${pct(rs.filter((r) => r.found).length, rs.length)} | ${pct(right.length, rs.length)} | ${rs.filter((r) => r.ok && r.extra).length} | ${rs.filter((r) => !r.ok && r.found && r.score >= 0.62).length} | ${rs.filter((r) => !r.ok && r.found && r.score >= 0.8).length} | ${right.length ? `${Math.min(...right).toFixed(2)} / ${med(right).toFixed(2)}` : "n/a"} | ${med(rs.map((r) => r.ms)).toFixed(0)} |`,
        );
      }
      console.log(`${cfg.name}: loaded in ${loadMs.toFixed(0)} ms, ${cfg.hidden.length} bundle rows hidden`);
    }
    lines.push("", ...worst.slice(0, 40).map((w) => `- ${w}`), "", ...misses.map((m) => `- MISS ${m}`));
    const report = lines.join("\n");
    console.log(report);
    writeFileSync(join(SPIKE_DIR, "supplement-results.md"), report + "\n");
    expect(compared).toBeGreaterThan(0);
  });
});
