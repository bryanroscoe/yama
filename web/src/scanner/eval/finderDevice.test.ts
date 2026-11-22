/// <reference types="node" />
// The parity set for the app's card finder on a device (CardFinderDeviceTest, web/android's
// androidTest): drawn frames of drawn cards (eval/syntheticCards.ts; no card image anywhere), held
// and drifting, turned, upside down, face down, too close, too far and gone, found by the web's own
// recognizer (recognizer.ts, `locate`) with the real card finder model in onnxruntime-web, as the
// scanner runs it. Writes the frames (raw RGBA), the model and what the web found, for the device
// test to run the app's port (CardFinder.java with ONNX Runtime for Android) on and compare; and
// every window the detector was shown with what it answered, so the two runtimes can be compared on
// exactly the same input (a tracked frame's window comes from the frame before's answer, so the
// smallest difference moves the next window, and the two drift apart a little along a track).
// Skipped in `npm test`; run with
//
//   SCANNER_FINDER_PARITY_DIR=/some/dir SCANNER_FINDER_MODEL=yama-corners-20261120.onnx \
//     npx vitest run web/src/scanner/eval/finderDevice.test.ts
//
// then push the folder to the app and run the test (docs/scanner.md, "The card finder in the app").

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecognizer, type OrtLike } from "../recognizer";
import type { RgbaImage } from "../types";
import { H, scene, W } from "./drawFrames";
import { drawBack, drawFront, type FrontLook } from "./syntheticCards";

const DIR = process.env.SCANNER_FINDER_PARITY_DIR;
const MODEL = process.env.SCANNER_FINDER_MODEL;
/** The pinned bundle's constants (gallery-20261106T183001884398Z manifest). */
const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };

const LOOKS: FrontLook[] = [
  { frame: [40, 110, 170], box: [200, 220, 235], art: [[30, 60, 120], [220, 230, 240], [90, 140, 60]] },
  { frame: [170, 40, 30], box: [235, 215, 190], art: [[200, 80, 40], [60, 30, 20], [240, 200, 120]] },
  { frame: [60, 130, 60], box: [210, 225, 200], art: [[30, 90, 40], [120, 170, 80], [200, 220, 150]] },
  { frame: [225, 220, 205], box: [240, 238, 230], art: [[180, 170, 140], [90, 80, 60], [250, 240, 200]] },
  { frame: [30, 30, 35], box: [190, 185, 180], art: [[80, 40, 120], [20, 20, 30], [160, 120, 200]] },
  { frame: [190, 160, 90], box: [235, 225, 200], art: [[120, 90, 40], [220, 190, 120], [60, 50, 30]] },
];

function frames(): { name: string; image: RgbaImage }[] {
  const out: { name: string; image: RgbaImage }[] = [];
  const cards = LOOKS.map((l, i) => drawFront(l, 504, 704, { noise: 6 }, i + 1));
  const angles = [0, 7, -12, 90, 180, 35];
  const jitter = [
    [0, 0, 0],
    [2, -1, 0.3],
    [-1, 2, -0.2],
    [3, 1, 0.4],
    [1, 3, -0.3],
  ] as const;
  cards.forEach((card, i) => {
    for (const [f, [jx, jy, ja]] of jitter.entries()) {
      out.push({ name: `card${i}-${f}`, image: scene({ card, cx: 300 + (i % 3) * 25 + jx, cy: 520 + (i % 2) * 60 + jy, width: 300 + i * 12, angle: angles[i]! + ja }, i * 10 + f) });
    }
  });
  out.push({ name: "empty-0", image: scene(null, 101) });
  out.push({ name: "empty-1", image: scene(null, 102) });
  const back = drawBack(504, 704, { noise: 4 }, 7);
  out.push({ name: "back-0", image: scene({ card: back, cx: 330, cy: 560, width: 320, angle: -4 }, 103) });
  out.push({ name: "back-1", image: scene({ card: back, cx: 331, cy: 561, width: 320, angle: -4.2 }, 104) });
  out.push({ name: "close", image: scene({ card: cards[1]!, cx: 320, cy: 569, width: 600, angle: 3 }, 105) });
  out.push({ name: "far", image: scene({ card: cards[2]!, cx: 200, cy: 400, width: 90, angle: 10 }, 106) });
  return out;
}

describe.skipIf(!DIR || !MODEL)("the app's card finder parity set", () => {
  it("is written with what the web's finder found", async () => {
    const ort = (await import("onnxruntime-web")) as unknown as OrtLike & { env: { wasm: { numThreads: number } } };
    ort.env.wasm.numThreads = 1;
    // Only the finder runs here; the art graphs are stand-ins that are never asked anything.
    const stand = { inputNames: ["scene", "quad"], run: async () => ({ embeddings: { data: new Float32Array(4) } }) };
    const search = { inputNames: ["embeddings"], run: async () => ({ indices: { data: BigInt64Array.from([]) }, scores: { data: Float32Array.from([]) } }) };
    const real = await ort.InferenceSession.create(readFileSync(MODEL!), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    let runs = 0;
    const passes: { window: string; quad: number[]; up: number[]; centre: number[]; short: number }[] = [];
    mkdirSync(join(DIR!, "windows"), { recursive: true });
    const counted = {
      inputNames: real.inputNames,
      run: async (feeds: Record<string, unknown>) => {
        runs += 1;
        const out = (await real.run(feeds)) as Record<string, { data: Float32Array }>;
        const name = `${String(passes.length).padStart(3, "0")}.rgba`;
        writeFileSync(join(DIR!, "windows", name), (feeds.window as { data: Uint8Array }).data);
        passes.push({ window: name, quad: [...out.quad!.data], up: [...out.up!.data], centre: [...out.centre!.data], short: out.short!.data[0]! });
        return out;
      },
    };
    const fake: OrtLike = {
      Tensor: ort.Tensor,
      InferenceSession: { create: async (m: Uint8Array) => (m[0] === 1 ? counted : m[0] === 2 ? stand : search) as never },
    };
    const r = await createRecognizer(fake, { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: Uint8Array.of(3) }, constants, []);
    r.reset();
    // The warm-up's passes (a blank frame) aren't part of the set.
    passes.length = 0;
    mkdirSync(join(DIR!, "frames"), { recursive: true });
    copyFileSync(MODEL!, join(DIR!, "model.onnx"));
    const list = frames();
    const seen = [];
    for (const f of list) {
      runs = 0;
      const l = await r.locate(f.image);
      writeFileSync(join(DIR!, "frames", `${f.name}.rgba`), f.image.data);
      seen.push({ name: f.name, runs, inView: !!l.quad, vote: l.upright, ...(l.quad ? { quad: l.quad.flat() } : {}) });
    }
    writeFileSync(join(DIR!, "expected.json"), JSON.stringify({ constants, width: W, height: H, frames: seen, passes }, null, 1));
    expect(seen.filter((s) => s.inView).length).toBeGreaterThan(20);
  }, 600_000);
});
