/// <reference types="node" />
// Star Trek (TRK, TRC; released 13 Nov 2026, after the pinned art bundle of 26 Oct) on simulated
// hand-held captures: what the art recognizer says about cards it has never seen, and whether
// reading the title first (setlock.ts, readTitleFirst) names them. Bryan, 15 Nov 2026: "none of
// the Star Trek cards scan". Skipped in `npm test`; run with
//
//   SCANNER_TRK_EVAL=1 YAMA_DB=<a card database with TRK and TRC> SCANNER_BUNDLE_DIR=<bundle> \
//     npx vitest run web/src/scanner/eval/trk.test.ts
//
// The cards are ones Bryan owns (picked from his collection on 15 Nov 2026).

import jpeg from "jpeg-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NameIndex } from "../fuzzy";
import { normaliseName } from "../parse";
import { scanFrame } from "../pipeline";
import { createRecognizer, parseArts, type OrtLike } from "../recognizer";
import { readTitleFirst } from "../setlock";
import type { Point, Quad, RgbaImage, ScanResult } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { DB_PATH, SPIKE_DIR } from "./fixtures";
import { FREEHAND, renderScene, VARIANTS } from "./simulate";
import { createEvalOcr } from "./ocr";

const BUNDLE = process.env.SCANNER_BUNDLE_DIR ?? "/tmp/yama-scan-bundle";
const SHORT = 640;
const LOCK_ONCE = 0.82;
const LOCK_TWICE = 0.62;
const ART_UNKNOWN = 0.5;

const CARDS: { set: string; number: string; name: string }[] = [
  { set: "trk", number: "12", name: "DOT-7 Repair Squad" },
  { set: "trk", number: "26", name: "Oberth-Class Starship" },
  { set: "trk", number: "42", name: "Una Chin-Riley, Number One" },
  { set: "trk", number: "60", name: "Guidance Failure" },
  { set: "trk", number: "78", name: "Rules of Acquisition" },
  { set: "trk", number: "90", name: "Zefram Cochrane, Warp Pioneer" },
  { set: "trk", number: "105", name: "Eject the Warp Core" },
  { set: "trk", number: "123", name: "Pattern Buffer Preservation" },
  { set: "trk", number: "130", name: "Stray from History" },
  { set: "trk", number: "143", name: "Captain Michael Burnham" },
  { set: "trk", number: "156", name: "La'An Noonien-Singh, Security" },
  { set: "trk", number: "170", name: "Sarcophagus, Ship of the Dead" },
  { set: "trk", number: "184", name: "Astute Terraformer" },
  { set: "trk", number: "217", name: "Sylvia Tilly, Joy of Discovery" },
  { set: "trk", number: "236", name: "D'Vana Tendi, Optimistic Ensign" },
  { set: "trk", number: "247", name: "L'Rell, Fierce Visionary" },
  { set: "trk", number: "270", name: "Tricorder" },
  { set: "trk", number: "286", name: "Hallowed Fountain" },
  { set: "trk", number: "299", name: "Stomping Ground" },
  { set: "trc", number: "424", name: "Loran of the Third Path" },
  { set: "trc", number: "572", name: "Training Center" },
];

const decode = (buf: Uint8Array): RgbaImage => {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
};
const jpegRoundTrip = (img: RgbaImage, q: number): RgbaImage => decode(jpeg.encode({ data: img.data, width: img.width, height: img.height }, q).data);

/** Nearest-neighbour downscale: enough for the recognizer's 640 px input in this eval. */
function shrink(img: RgbaImage, k: number): RgbaImage {
  const w = Math.round(img.width * k);
  const h = Math.round(img.height * k);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(img.width - 1, Math.floor(x / k));
      const sy = Math.min(img.height - 1, Math.floor(y / k));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  return { width: w, height: h, data: out };
}

const quarterTurns = (q: Quad): Quad[] => [q, [q[1], q[2], q[3], q[0]], [q[3], q[0], q[1], q[2]]];

describe.skipIf(!process.env.SCANNER_TRK_EVAL)("Star Trek cards (art the bundle doesn't know)", () => {
  it("reads their titles", { timeout: 60 * 60 * 1000 }, async () => {
    const ort = (await import("onnxruntime-web")) as unknown as OrtLike & { env: { wasm: { numThreads: number } } };
    ort.env.wasm.numThreads = 1;
    const read = (f: string) => new Uint8Array(readFileSync(join(BUNDLE, f)));
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
    const arts = parseArts(JSON.parse(readFileSync(join(BUNDLE, "arts.json"), "utf8")));
    const recognizer = await createRecognizer(ort, { detector: read("detector.onnx"), embed: read("embed.onnx"), search: read("search.onnx") }, manifest.constants, arts);

    const catalog = openDbCatalog(DB_PATH);
    const all = new NameIndex(catalog.names());
    const trk = new NameIndex(CARDS.map((c) => c.name)); // stands in for the TRK lock's names
    const dir = join(SPIKE_DIR, "trk");
    mkdirSync(dir, { recursive: true });
    for (const c of CARDS) {
      const path = join(dir, `${c.set}-${c.number}.jpg`);
      if (existsSync(path)) continue;
      const normal = catalog.imageUrl(c.set, c.number);
      if (!normal) throw new Error(`no image for ${c.set} ${c.number}`);
      const url = normal.replace(/\/(normal|grid)\//, "/large/").replace(/\.webp(\?|$)/, ".jpg$1");
      const res = await fetch(url, { headers: { "User-Agent": "YamaScannerEval/0.1 (private test; a few dozen images)", Accept: "image/jpeg" } });
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
      await new Promise((r) => setTimeout(r, 150));
    }
    const ocr = await createEvalOcr();

    const variants = { "steady (guide)": VARIANTS.steady!, ...FREEHAND };
    const rows: { card: string; variant: string; artName: string; artScore: number; artRight: boolean; old: string; title: string; titleConf: number; titleRight: boolean; titleLocked: string; titleLockedConf: number; lockedRight: boolean }[] = [];
    let seed = 5000;
    for (const c of CARDS) {
      const card = decode(new Uint8Array(readFileSync(join(dir, `${c.set}-${c.number}.jpg`))));
      for (const [v, params] of Object.entries(variants)) {
        const scene = renderScene(card, params, seed++, jpegRoundTrip);
        const k = SHORT / Math.min(scene.frame.width, scene.frame.height);
        recognizer.reset();
        const r = await recognizer.identify(shrink(scene.frame, k));
        const top = r.matches[0];
        const score = top?.score ?? 0;
        // What the scanner did before: lock at 0.82 once (0.62 twice: counted as a lock here),
        // wait in the 0.50 to 0.62 band, read text below.
        const old = !r.quad || !top ? "no card" : score >= LOCK_ONCE ? "wrong lock" : score >= LOCK_TWICE ? "wrong lock (2 frames)" : score >= ART_UNKNOWN ? "stuck" : "text";
        const quad = (r.quad ? r.quad.map(([x, y]) => [x / k, y / k] as Point) : scene.guide) as Quad;
        const readWith = async (names: NameIndex) => {
          let best: ScanResult | null = null;
          for (const q of quarterTurns(quad)) {
            const res = await scanFrame(scene.frame, { ocr, catalog, names, guide: q, tryUpsideDown: true });
            if (!best || (res.candidates[0]?.confidence ?? 0) > (best.candidates[0]?.confidence ?? 0)) best = res;
            if ((best.candidates[0]?.confidence ?? 0) >= 0.95) break;
          }
          return best!.candidates[0];
        };
        const t = await readWith(all);
        const tl = await readWith(trk);
        rows.push({
          card: `${c.set}-${c.number}`,
          variant: v,
          artName: top?.name ?? "",
          artScore: score,
          artRight: !!top && normaliseName(top.name) === normaliseName(c.name),
          old,
          title: t?.name ?? "",
          titleConf: t?.confidence ?? 0,
          titleRight: !!t && t.name === c.name,
          titleLocked: tl?.name ?? "",
          titleLockedConf: tl?.confidence ?? 0,
          lockedRight: !!tl && tl.name === c.name,
        });
        const row = rows[rows.length - 1]!;
        console.log(
          `${c.set}-${c.number} [${v}] art ${row.artName} ${score.toFixed(2)} (${old}${readTitleFirst({ score, lockOnce: LOCK_ONCE, locked: false, inSet: false, share: 1 }) ? ", title first" : ""}) | title ${row.title || "nothing"} ${row.titleConf.toFixed(2)}${row.titleRight ? " ok" : ""} | locked ${row.titleLocked || "nothing"} ${row.titleLockedConf.toFixed(2)}${row.lockedRight ? " ok" : ""}`,
        );
      }
    }
    await ocr.terminate();
    catalog.close();

    const n = rows.length;
    const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
    const pct = (x: number) => `${Math.round((100 * x) / n)}%`;
    // New rule, no lock: art at 0.82 or more still decides (a wrong lock); below, the title decides
    // when it's sure (0.95 once, or 0.6 on two agreeing frames: counted at 0.6 here).
    const newNoLock = count((r) => (r.artScore >= LOCK_ONCE && r.artRight) || (r.artScore < LOCK_ONCE && r.titleRight && r.titleConf >= 0.6));
    const newWrongNoLock = count((r) => (r.artScore >= LOCK_ONCE && !r.artRight) || (r.artScore < LOCK_ONCE && !r.titleRight && r.titleConf >= 0.95));
    // New rule with the TRK lock: the title always decides (the bundle knows none of TRK's art).
    const newLocked = count((r) => r.lockedRight && r.titleLockedConf >= 0.6);
    const report = [
      `Star Trek eval: ${CARDS.length} cards x ${Object.keys(variants).length} captures = ${n} scans.`,
      "",
      `Before: art named the right card in ${pct(count((r) => r.old.startsWith("wrong lock") && r.artRight))}, locked a wrong card in ${pct(count((r) => r.old.startsWith("wrong lock") && !r.artRight))}, waited on "Hold still" in ${pct(count((r) => r.old === "stuck"))}, went to text in ${pct(count((r) => r.old === "text"))}, found no card in ${pct(count((r) => r.old === "no card"))}.`,
      `Art scores on these unseen cards: ${Math.min(...rows.map((r) => r.artScore)).toFixed(2)} to ${Math.max(...rows.map((r) => r.artScore)).toFixed(2)}.`,
      `Title read (all names): right ${pct(count((r) => r.titleRight))}; right and at least 0.6 sure ${pct(count((r) => r.titleRight && r.titleConf >= 0.6))}.`,
      `Title read (TRK lock's names): right and at least 0.6 sure ${pct(count((r) => r.lockedRight && r.titleLockedConf >= 0.6))}.`,
      `After, no lock: named right ${pct(newNoLock)}; named wrong (a wrong strong art lock, or a sure wrong title) ${pct(newWrongNoLock)}.`,
      `After, locked to TRK: named right ${pct(newLocked)}.`,
    ].join("\n");
    console.log(report);
    writeFileSync(join(SPIKE_DIR, "trk-results.md"), report + "\n");
    writeFileSync(join(SPIKE_DIR, "trk-rows.json"), JSON.stringify(rows, null, 1));
    expect(n).toBeGreaterThan(0);
  });
});
