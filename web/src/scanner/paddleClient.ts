// Main-thread side of the browser OCR: starts ocr.worker.ts, loads the PaddleOCR models and
// hands it crops. An OcrEngine like tesseract.ts.

import type { Gray, OcrEngine } from "./types";

export type OcrWorkerRequest =
  | { type: "load"; dir: string }
  | { type: "read"; id: number; width: number; height: number; data: Uint8ClampedArray; mode: "line" | "block"; whitelist?: string };

export type OcrWorkerReply =
  | { type: "ready"; ms: number }
  | { type: "error"; message: string }
  | { type: "result"; id: number; text: string; confidence: number }
  | { type: "failed"; id: number; message: string };

export interface WorkerOcr extends OcrEngine {
  terminate(): Promise<void>;
}

/** Loading the models gives up after this long (a stalled download), so the caller can fall back. */
const LOAD_TIMEOUT_MS = 90_000;

/** The PaddleOCR engine in a worker, once its models (in `dir`, e.g. "/ocr/paddle-…") are loaded. */
export function createPaddleWorkerOcr(dir: string): Promise<WorkerOcr> {
  const worker = new Worker(new URL("./ocr.worker.ts", import.meta.url), { type: "module" });
  const waiting = new Map<number, { resolve: (r: { text: string; confidence: number }) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let dead: Error | null = null;
  const fail = (e: Error) => {
    dead ??= e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  return new Promise<WorkerOcr>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      fail(new Error("The OCR models took too long to load"));
      reject(dead);
    }, LOAD_TIMEOUT_MS);
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      fail(new Error(e.message || "The OCR worker failed"));
      reject(dead);
    };
    worker.onmessage = (event: MessageEvent<OcrWorkerReply>) => {
      const m = event.data;
      if (m.type === "ready") {
        clearTimeout(timer);
        resolve({
          read(img: Gray, opts) {
            if (dead) return Promise.reject(dead);
            const id = nextId++;
            return new Promise((res, rej) => {
              waiting.set(id, { resolve: res, reject: rej });
              worker.postMessage({ type: "read", id, width: img.width, height: img.height, data: img.data, mode: opts.mode, whitelist: opts.whitelist } satisfies OcrWorkerRequest);
            });
          },
          async terminate() {
            worker.terminate();
            fail(new Error("The OCR engine was closed"));
          },
        });
      } else if (m.type === "error") {
        clearTimeout(timer);
        worker.terminate();
        fail(new Error(m.message));
        reject(dead);
      } else {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.type === "result") w?.resolve({ text: m.text, confidence: m.confidence });
        else w?.reject(new Error(m.message));
      }
    };
    worker.postMessage({ type: "load", dir } satisfies OcrWorkerRequest);
  });
}
