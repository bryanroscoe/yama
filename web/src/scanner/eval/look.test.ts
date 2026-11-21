/// <reference types="node" />
// The printing look model in Node, as the art worker runs it (onnxruntime-web, WASM, one thread):
//
// - Parity: the release file on two synthetic scenes (no card images in the repository) against
//   what the lab's Python onnxruntime gave (look-parity.json, made by the lab's parity.py; see
//   docs/scanner.md, "The printing look"). Run with
//     SCANNER_LOOK_MODEL=<yama-look-v0.onnx> npx vitest run web/src/scanner/eval/look.test.ts
// - Real photos: with SCANNER_LOOK_CASES (the lab's cases.py output: each photo's quad, its printing
//   and the printings that share its art, with Python's scores), SCANNER_REAL_DIR (the photos) and
//   SCANNER_LOOK_PRINTINGS (each printing's Scryfall `normal` image as <id>.jpg, or decoded to
//   <id>.rgba where the lab kept a WebP), every photo is
//   scored with look.ts's code and compared with Python's. Photos too may be <id>.rgba (decoded as
//   the lab decoded them; then SCANNER_LOOK_SAME_PIXELS=1 asks for the same scores to 5e-4). People's photos: they stay outside the
//   repository, and so do the cases.
// Skipped in `npm test`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { cornersOf, embedLook, lookScore, type LookSession, type LookTensor } from "../look";
import type { Quad, RgbaImage } from "../types";

const parity = JSON.parse(readFileSync(new URL("./look-parity.json", import.meta.url), "utf8")) as {
  model: string;
  cases: { name: string; width: number; height: number; quad: number[][]; symbol: number[]; card: number[] }[];
};

const MODEL = process.env.SCANNER_LOOK_MODEL;
const CASES = process.env.SCANNER_LOOK_CASES;
const PHOTOS = process.env.SCANNER_REAL_DIR;
const PRINTINGS = process.env.SCANNER_LOOK_PRINTINGS;

/** The scene parity.py draws: a pattern no card is in. */
function scene(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      data[o] = (x * 7 + y * 3) & 255;
      data[o + 1] = (((x * x) >> 3) + y * 5) & 255;
      data[o + 2] = ((x ^ y) * 3) & 255;
      data[o + 3] = 255;
    }
  return { width, height, data };
}

async function session(): Promise<{ s: LookSession; Tensor: LookTensor }> {
  const ort = (await import("onnxruntime-web")) as unknown as { env: { wasm: { numThreads: number } }; InferenceSession: { create(m: Uint8Array): Promise<LookSession> }; Tensor: LookTensor };
  ort.env.wasm.numThreads = 1;
  return { s: await ort.InferenceSession.create(new Uint8Array(readFileSync(MODEL!))), Tensor: ort.Tensor };
}

const maxDiff = (a: Float32Array, b: number[]) => Math.max(...b.map((v, i) => Math.abs(v - a[i]!)));
/** A printing's picture: a JPEG, or raw RGBA (`<id>.rgba`: width and height as uint32 LE, then the pixels; the lab's WebP files decoded by raw.py). */
const picture = (dir: string, id: string): RgbaImage => {
  try {
    const raw = readFileSync(join(dir, `${id}.rgba`));
    const width = raw.readUInt32LE(0);
    const height = raw.readUInt32LE(4);
    return { width, height, data: new Uint8ClampedArray(raw.buffer, raw.byteOffset + 8, width * height * 4) };
  } catch {
    return decode(join(dir, `${id}.jpg`));
  }
};
const decode = (path: string): RgbaImage => {
  const d = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

describe.skipIf(!MODEL)("the printing look model in onnxruntime-web", () => {
  it("gives the lab's Python outputs on synthetic scenes", { timeout: 120_000 }, async () => {
    expect(createHash("sha256").update(readFileSync(MODEL!)).digest("hex")).toBe(parity.model);
    const { s, Tensor } = await session();
    for (const c of parity.cases) {
      const e = await embedLook(s, Tensor, scene(c.width, c.height), c.quad as Quad);
      const worst = Math.max(maxDiff(e.symbol, c.symbol), maxDiff(e.card, c.card));
      console.log(`${c.name}: largest difference from Python ${worst.toExponential(2)}`);
      expect(worst).toBeLessThan(2e-4);
    }
  });

  it.skipIf(!CASES || !PHOTOS || !PRINTINGS)("ranks the real photos' printings as the lab did", { timeout: 30 * 60_000 }, async () => {
    const { s, Tensor } = await session();
    const { cases } = JSON.parse(readFileSync(CASES!, "utf8")) as { cases: { photo: string; quad: Quad; label: string; siblings: string[]; scores: number[] }[] };
    const keys = new Map<string, Awaited<ReturnType<typeof embedLook>>>();
    const decodeMs: number[] = [];
    const keyMs: number[] = [];
    const queryMs: number[] = [];
    let right = 0;
    let worst = 0;
    for (const c of cases) {
      const t0 = performance.now();
      const q = await embedLook(s, Tensor, picture(PHOTOS!, c.photo), c.quad);
      queryMs.push(performance.now() - t0);
      const scores: number[] = [];
      for (const id of c.siblings) {
        if (!keys.has(id)) {
          const t1 = performance.now();
          const img = picture(PRINTINGS!, id);
          const t2 = performance.now();
          keys.set(id, await embedLook(s, Tensor, img, cornersOf(img.width, img.height)));
          decodeMs.push(t2 - t1);
          keyMs.push(performance.now() - t2);
        }
        scores.push(lookScore(q, keys.get(id)!));
      }
      worst = Math.max(worst, ...scores.map((x, i) => Math.abs(x - c.scores[i]!)));
      const best = scores.indexOf(Math.max(...scores));
      if (c.siblings[best] === c.label) right += 1;
    }
    const pct = (n: number) => `${((100 * n) / cases.length).toFixed(1)}%`;
    console.log(
      `${cases.length} photos: right printing first by look ${right} (${pct(right)}); largest score difference from Python ${worst.toExponential(2)}.\n` +
        `Median ms: card side ${median(queryMs).toFixed(0)}, printing decode (jpeg-js) ${median(decodeMs).toFixed(0)}, printing embed ${median(keyMs).toFixed(0)} (${keys.size} printings).`,
    );
    // The same pixels give the same scores; JPEGs decoded here (jpeg-js) rather than by OpenCV, as
    // the lab decoded them, differ by a few hundredths at most and rank the same on these photos.
    expect(worst).toBeLessThan(process.env.SCANNER_LOOK_SAME_PIXELS ? 5e-4 : 0.05);
    const python = cases.filter((c) => c.siblings[c.scores.indexOf(Math.max(...c.scores))] === c.label).length;
    expect(right).toBe(python);
  });
});
