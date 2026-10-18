// OcrEngine backed by tesseract.js (Apache-2.0) with the English LSTM model.
// Two workers, one per crop kind, so the collector line and the title are read in parallel and
// each worker keeps its own parameters.
//
// By default tesseract.js loads its worker script, WASM core and eng.traineddata from the
// jsDelivr CDN (about 3 MB of model plus about 3 MB of WASM, cached after the first load).
// For offline use, pass `paths` pointing at copies served by the app.

import { createWorker, PSM, OEM, type Worker } from "tesseract.js";
import { encodeBmp } from "./image";
import type { Gray, OcrEngine, OcrResult } from "./types";

export interface TesseractPaths {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
  cachePath?: string;
}

export interface TesseractOcr extends OcrEngine {
  terminate(): Promise<void>;
}

export async function createTesseractOcr(paths: TesseractPaths = {}): Promise<TesseractOcr> {
  const make = () =>
    createWorker("eng", OEM.LSTM_ONLY, {
      ...paths,
      // tesseract.js fetches eng.traineddata.gz from langPath.
      gzip: true,
    });
  const [line, block] = await Promise.all([make(), make()]);
  await line.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, user_defined_dpi: "300" });
  await block.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, user_defined_dpi: "300" });
  const whitelists = new Map<Worker, string>();

  const toInput = (img: Gray) => {
    const bmp = encodeBmp(img);
    // Node wants a Buffer; browsers take a Blob.
    const B = (globalThis as { Buffer?: { from(u: Uint8Array): unknown } }).Buffer;
    return (typeof window === "undefined" && B ? B.from(bmp) : new Blob([bmp as BlobPart], { type: "image/bmp" })) as Blob;
  };

  return {
    async read(img, opts): Promise<OcrResult> {
      const worker = opts.mode === "line" ? line : block;
      const wl = opts.whitelist ?? "";
      if (whitelists.get(worker) !== wl) {
        await worker.setParameters({ tessedit_char_whitelist: wl });
        whitelists.set(worker, wl);
      }
      const { data } = await worker.recognize(toInput(img));
      return { text: data.text.trim(), confidence: data.confidence };
    },
    async terminate() {
      await Promise.all([line.terminate(), block.terminate()]);
    },
  };
}
