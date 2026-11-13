/// <reference lib="webworker" />
// The browser's OCR (PaddleOCR, paddle.ts) off the main thread. The models are served by the app
// under /ocr/paddle-<checksums>/ (scripts/copy-ocr.mjs), immutable, and kept by the service worker.
// One WASM thread, like the art recognizer: Yama isn't cross-origin isolated.

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { createPaddleOcr, type OrtLike, type PaddleOcr } from "./paddle";
import type { OcrWorkerReply, OcrWorkerRequest } from "./paddleClient";

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

let ocr: PaddleOcr | null = null;
const reply = (m: OcrWorkerReply) => (self as DedicatedWorkerGlobalScope).postMessage(m);

async function get(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${url.split("/").pop()} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function load(dir: string) {
  const t0 = performance.now();
  const at = (name: string) => new URL(`${dir}/${name}`, self.location.origin).href;
  const [rec, det, dict] = await Promise.all([get(at("rec.onnx")), get(at("det.onnx")), get(at("dict.txt"))]);
  ocr = await createPaddleOcr(ort as unknown as OrtLike, { rec, det, dict: new TextDecoder().decode(dict) });
  reply({ type: "ready", ms: performance.now() - t0 });
}

self.onmessage = async (event: MessageEvent<OcrWorkerRequest>) => {
  const m = event.data;
  try {
    if (m.type === "load") await load(m.dir);
    else {
      if (!ocr) throw new Error("The OCR models aren't loaded");
      const r = await ocr.read({ width: m.width, height: m.height, data: m.data }, { mode: m.mode, whitelist: m.whitelist });
      reply({ type: "result", id: m.id, text: r.text, confidence: r.confidence });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reply(m.type === "read" ? { type: "failed", id: m.id, message } : { type: "error", message });
  }
};
