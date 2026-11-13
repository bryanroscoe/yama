/// <reference types="node" />
// The OCR engine for the evals: PaddleOCR, the browser's engine (the default; its pinned models are
// downloaded into the spike folder by the build's own script, web/scripts/paddle-models.mjs), or
// SCANNER_OCR=tesseract. SCANNER_DUMP=<dir> writes every crop read as a PGM, with the lines found by
// rows marked, for looking at misreads.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPaddleOcr, findLines, type OrtLike } from "../paddle";
import { createTesseractOcr } from "../tesseract";
import type { OcrEngine } from "../types";
import { SPIKE_DIR } from "./fixtures";

type EvalOcr = OcrEngine & { terminate(): Promise<void> };

async function paddle(): Promise<EvalOcr> {
  const script = new URL("../../../scripts/paddle-models.mjs", import.meta.url).pathname;
  const { ensurePaddleModels } = (await import(/* @vite-ignore */ script)) as { ensurePaddleModels(dir: string): Promise<Record<string, string>> };
  const files = await ensurePaddleModels(join(SPIKE_DIR, "paddle"));
  const ort = (await import("onnxruntime-web")) as unknown as OrtLike & { env: { wasm: { numThreads: number } } };
  ort.env.wasm.numThreads = 1; // as on a phone
  return createPaddleOcr(ort, { rec: readFileSync(files["rec.onnx"]!), det: readFileSync(files["det.onnx"]!), dict: readFileSync(files["dict.txt"]!, "utf8") });
}

function tesseract(): Promise<EvalOcr> {
  const langDir = join(SPIKE_DIR, "lang");
  return createTesseractOcr(existsSync(join(langDir, "eng.traineddata.gz")) ? { langPath: langDir, cachePath: langDir } : { cachePath: langDir });
}

export async function createEvalOcr(): Promise<EvalOcr> {
  const ocr = process.env.SCANNER_OCR === "tesseract" ? await tesseract() : await paddle();
  const dir = process.env.SCANNER_DUMP;
  if (!dir) return ocr;
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return {
    async read(img, opts) {
      const r = await ocr.read(img, opts);
      const d = new Uint8ClampedArray(img.data);
      for (const b of findLines(img)) for (const y of [b.top, b.bottom - 1]) for (let x = 0; x < img.width; x += 2) d[y * img.width + x] = 128;
      const head = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`);
      writeFileSync(join(dir, `${opts.mode}-${String(n++).padStart(4, "0")}.pgm`), Buffer.concat([head, Buffer.from(d)]));
      writeFileSync(join(dir, `${opts.mode}-${String(n - 1).padStart(4, "0")}.txt`), r.text);
      return r;
    },
    terminate: () => ocr.terminate(),
  };
}
