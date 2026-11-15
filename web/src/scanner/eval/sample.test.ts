/// <reference types="node" />
// One real scan photo through the art recognizer and the title read, for a failure reported from a
// phone (the start of the replay set the diagnostics will grow). Skipped in `npm test`; run with
//
//   SCANNER_SAMPLE=<photo.jpg> SCANNER_SAMPLE_NAME="Westvale Abbey // Ormendahl, Profane Prince" \
//     YAMA_DB=<card db> SCANNER_BUNDLE_DIR=<bundle> npx vitest run web/src/scanner/eval/sample.test.ts
//
// The photo is a kept scan photo (scan_samples.image: the frame around the card, at most 640 px).
// Photos are people's own and stay out of the repository.

import jpeg from "jpeg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NameIndex } from "../fuzzy";
import { normaliseName } from "../parse";
import { scanFrame } from "../pipeline";
import { createRecognizer, parseArts, type OrtLike } from "../recognizer";
import { readTitleFirst } from "../setlock";
import type { Quad, RgbaImage, ScanResult } from "../types";
import { openDbCatalog } from "./dbCatalog";
import { DB_PATH } from "./fixtures";
import { createEvalOcr } from "./ocr";

const BUNDLE = process.env.SCANNER_BUNDLE_DIR ?? "/tmp/yama-scan-bundle";
const PHOTO = process.env.SCANNER_SAMPLE;
const WANT = process.env.SCANNER_SAMPLE_NAME ?? "";

const quarterTurns = (q: Quad): Quad[] => [q, [q[1], q[2], q[3], q[0]], [q[3], q[0], q[1], q[2]]];

describe.skipIf(!PHOTO)("a real scan photo", () => {
  it("is named by art or title", { timeout: 10 * 60 * 1000 }, async () => {
    const ort = (await import("onnxruntime-web")) as unknown as OrtLike & { env: { wasm: { numThreads: number } } };
    ort.env.wasm.numThreads = 1;
    const read = (f: string) => new Uint8Array(readFileSync(join(BUNDLE, f)));
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
    const arts = parseArts(JSON.parse(readFileSync(join(BUNDLE, "arts.json"), "utf8")));
    const recognizer = await createRecognizer(ort, { detector: read("detector.onnx"), embed: read("embed.onnx"), search: read("search.onnx") }, manifest.constants, arts);
    const d = jpeg.decode(readFileSync(PHOTO!), { useTArray: true, formatAsRGBA: true });
    const frame: RgbaImage = { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer) };

    const r = await recognizer.identify(frame);
    const top = r.matches[0];
    const score = top?.score ?? 0;
    const titleFirst = readTitleFirst({ score, lockOnce: 0.82, locked: false, inSet: false, share: 1 });

    const catalog = openDbCatalog(DB_PATH);
    const names = new NameIndex(catalog.names());
    const ocr = await createEvalOcr();
    let best: ScanResult | null = null;
    const quad = (r.quad ?? [[0, 0], [frame.width, 0], [frame.width, frame.height], [0, frame.height]]) as Quad;
    for (const q of quarterTurns(quad)) {
      const res = await scanFrame(frame, { ocr, catalog, names, guide: q, tryUpsideDown: true });
      if (!best || (res.candidates[0]?.confidence ?? 0) > (best.candidates[0]?.confidence ?? 0)) best = res;
      if ((best.candidates[0]?.confidence ?? 0) >= 0.95) break;
    }
    await ocr.terminate();
    catalog.close();
    const title = best!.candidates[0];
    const named = titleFirst && title && title.confidence >= 0.6 ? title.name : top?.name;
    const report = (
      [
        `Art: ${r.matches.slice(0, 3).map((m) => `${m.name} (${m.set} ${m.score.toFixed(3)})`).join(", ")}; card found: ${!!r.quad}.`,
        `Title read first: ${titleFirst}. Title: ${title ? `${title.name} ${title.set ?? ""} ${title.number ?? ""} (${title.method} ${title.confidence.toFixed(2)})` : "nothing"}.`,
        `Raw: ${best!.raw.name} || ${best!.raw.collector.replace(/\n/g, " | ")}`,
        `The scanner now names: ${named ?? "nothing"}${WANT ? ` (want ${WANT})` : ""}.`,
      ].join("\n")
    );
    console.log(report);
    writeFileSync(`${PHOTO}.result.txt`, report + "\n");
    if (WANT) expect(normaliseName(named ?? "")).toBe(normaliseName(WANT));
  });
});
