/// <reference types="node" />
// The parity set for the art read in the app (ArtEmbedderDeviceTest, web/android's androidTest):
// real cards' Scryfall pictures (fetched into a folder of your own at run time; none is in the
// repository) laid on drawn frames, turned and upside down, and each one's art read by the web
// worker's own way (recognizer.ts's `cardWindow` crop, the art graph in onnxruntime-web on one
// thread): every cut's embedding, the cascade's first stage when the model has one, and the
// search's best five. Writes the frames (raw RGBA), the model and what the web read, for the device
// test to read the same art with ONNX Runtime for Android and compare. Skipped in `npm test`; run
//
//   SCANNER_ART_PARITY_DIR=/some/dir SCANNER_ART_MODEL=yama-art-20261118.onnx \
//     SCANNER_CARD_IMAGES=/folder/of/jpegs SCANNER_SEARCH=search.onnx \
//     npx vitest run web/src/scanner/eval/artDevice.test.ts
//
// and, with the device test's `native.json` pulled back as SCANNER_ART_NATIVE, again to check that
// the search puts the same card first on the app's embeddings (docs/scanner.md, "The art read in the app").

import jpeg from "jpeg-js";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGallery } from "../gallery";
import { cardWindow, FIRST_STAGE } from "../recognizer";
import type { RgbaImage } from "../types";
import { H, placedQuad, scene, W, type Placed } from "./drawFrames";

const DIR = process.env.SCANNER_ART_PARITY_DIR;
const MODEL = process.env.SCANNER_ART_MODEL;
const CARDS = process.env.SCANNER_CARD_IMAGES;
const SEARCH = process.env.SCANNER_SEARCH;
const NATIVE = process.env.SCANNER_ART_NATIVE;
/** The pinned bundle's frame cuts, in the embed graph's row order (gallery-20261106T183001884398Z). */
const FRAME_NAMES = ["modern", "old", "extended", "tall", "right", "left", "room_0", "room_1", "split_0", "split_1", "aftermath_0", "aftermath_1", "flip_0", "flip_1", "token", "token_tall", "emblem"];

interface Ort {
  env: { wasm: { numThreads: number } };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => { data: unknown };
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<{ inputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims?: readonly number[] }>> }> };
}

const b64 = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
const floats = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

async function ort(): Promise<Ort> {
  const o = (await import("onnxruntime-web")) as unknown as Ort;
  o.env.wasm.numThreads = 1;
  return o;
}

async function searcher(o: Ort) {
  if (!SEARCH) return null;
  // A fresh array: the gallery reader views it as wider types, which need an aligned start.
  const bytes = new Uint8Array(readFileSync(SEARCH));
  const session = await o.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  const count = readGallery(bytes).count;
  const mask = session.inputNames.includes("mask") ? new o.Tensor("float32", new Float32Array(count).fill(1), [count]) : null;
  return async (embedding: Float32Array, rows: number, dim: number) => {
    const out = await session.run({ embeddings: new o.Tensor("float32", embedding, [rows, dim]), ...(mask ? { mask } : {}) });
    const indices = out.indices!.data as BigInt64Array | Int32Array;
    const scores = out.scores!.data as Float32Array;
    return [...indices].map((i, k) => ({ index: Number(i), score: scores[k]! }));
  };
}

function frames(): { name: string; image: RgbaImage; quad: number[] }[] {
  const files = readdirSync(CARDS!).filter((f) => /\.jpe?g$/i.test(f)).sort();
  const out: { name: string; image: RgbaImage; quad: number[] }[] = [];
  const layouts: Omit<Placed, "card">[] = [
    { cx: 320, cy: 560, width: 360, angle: 0 },
    { cx: 300, cy: 600, width: 320, angle: 9 },
    { cx: 340, cy: 520, width: 300, angle: -14 },
    { cx: 320, cy: 570, width: 340, angle: 180 },
  ];
  files.forEach((f, i) => {
    const d = jpeg.decode(readFileSync(join(CARDS!, f)), { useTArray: true, formatAsRGBA: true });
    const card: RgbaImage = { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };
    layouts.forEach((l, j) => {
      const p = { ...l, card };
      out.push({ name: `${f.replace(/\.jpe?g$/i, "")}-${j}`, image: scene(p, i * 10 + j), quad: placedQuad(p).flat() });
    });
  });
  return out;
}

describe.skipIf(!DIR || !MODEL || !CARDS)("the art read in the app's parity set", () => {
  it.skipIf(!!NATIVE)("is written with what the web worker read", async () => {
    const o = await ort();
    const art = await o.InferenceSession.create(readFileSync(MODEL!), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    const takesCuts = art.inputNames.includes("cuts");
    const search = await searcher(o);
    const first = FRAME_NAMES.flatMap((n, i) => (FIRST_STAGE.includes(n) ? [i] : []));
    const read = async (image: RgbaImage, quad: number[], cuts?: number[]) => {
      const { frame, quad: q } = cardWindow(image, [0, 1, 2, 3].map((i) => [quad[i * 2]!, quad[i * 2 + 1]!]) as never);
      const feeds: Record<string, unknown> = {
        scene: new o.Tensor("uint8", new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), [frame.height, frame.width, 4]),
        quad: new o.Tensor("float32", Float32Array.from(q.flat()), [4, 2]),
      };
      if (takesCuts) {
        const c = cuts ?? FRAME_NAMES.map((_, i) => i);
        feeds.cuts = new o.Tensor("int64", BigInt64Array.from(c, (i) => BigInt(i)), [c.length]);
      }
      const out = Object.values(await art.run(feeds))[0]!;
      const data = Float32Array.from(out.data as Float32Array);
      const dims = out.dims ?? [FRAME_NAMES.length, data.length / FRAME_NAMES.length];
      return { data, rows: dims[dims.length - 2] ?? 1, dim: dims[dims.length - 1]! };
    };
    mkdirSync(join(DIR!, "frames"), { recursive: true });
    copyFileSync(MODEL!, join(DIR!, "model.onnx"));
    const seen = [];
    for (const f of frames()) {
      const all = await read(f.image, f.quad);
      const stage = takesCuts ? await read(f.image, f.quad, first) : null;
      writeFileSync(join(DIR!, "frames", `${f.name}.rgba`), f.image.data);
      seen.push({ name: f.name, quad: f.quad, rows: all.rows, dim: all.dim, embedding: b64(all.data), ...(stage ? { first: b64(stage.data), firstCuts: first } : {}), ...(search ? { top: await search(all.data, all.rows, all.dim) } : {}) });
    }
    writeFileSync(join(DIR!, "expected.json"), JSON.stringify({ width: W, height: H, cascade: takesCuts, frames: seen }));
    expect(seen.length).toBeGreaterThan(8);
  }, 900_000);

  it.skipIf(!NATIVE || !SEARCH)("puts the same card first on the app's embeddings", async () => {
    const o = await ort();
    const search = (await searcher(o))!;
    const expected = JSON.parse(readFileSync(join(DIR!, "expected.json"), "utf8")) as { frames: { name: string; rows: number; dim: number; top: { index: number; score: number }[] }[] };
    const native = JSON.parse(readFileSync(NATIVE!, "utf8")) as { name: string; embedding: string }[];
    let same = 0;
    let gap = 0;
    for (const n of native) {
      const want = expected.frames.find((f) => f.name === n.name)!;
      const got = await search(floats(n.embedding), want.rows, want.dim);
      if (got[0]!.index === want.top[0]!.index) same += 1;
      gap = Math.max(gap, Math.abs(got[0]!.score - want.top[0]!.score));
    }
    console.info(`the same card first on ${same} of ${native.length} frames; the best score within ${gap.toFixed(5)}`);
    expect(same).toBe(native.length);
    expect(gap).toBeLessThan(0.002);
  }, 900_000);
});
