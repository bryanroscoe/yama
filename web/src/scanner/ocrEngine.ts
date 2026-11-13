// Which OCR engine the scanner reads text with: ML Kit inside the Android app; PaddleOCR (PP-OCRv5)
// in a worker when the build has its models (paddle.ts, docs/scanner.md "Browser OCR: PP-OCRv5");
// Tesseract if neither is there, the models fail to load, or the PaddleOCR worker fails later.

import { Capacitor } from "@capacitor/core";
import { createMlKitOcr } from "./mlkit";
import { createPaddleWorkerOcr, type WorkerOcr } from "./paddleClient";
import { createTesseractOcr, type TesseractPaths } from "./tesseract";
import type { OcrEngine } from "./types";

export interface OwnedOcr extends OcrEngine {
  terminate(): Promise<void>;
}

export interface ScannerOcr extends OwnedOcr {
  /** Which engine this is, for the scanner's diagnostics. */
  engine: "mlkit" | "paddle" | "tesseract";
}

/** Reads in a row that may fail before the fallback takes over from an engine still running. */
const FAILURES_BEFORE_FALLBACK = 3;

/**
 * `primary`, switching to `backup` for good once it is dead (`dead()`, the worker crashed) or has
 * failed several reads in a row. A single failed read is just that read's failure.
 */
export function withFallback(primary: OwnedOcr & { dead?(): boolean }, backup: () => Promise<OwnedOcr>): OwnedOcr {
  let second: Promise<OwnedOcr> | null = null;
  let failedOver = false;
  let failures = 0;
  let closed = false;
  return {
    async read(img, opts) {
      if (!failedOver) {
        try {
          const r = await primary.read(img, opts);
          failures = 0;
          return r;
        } catch (e) {
          if (closed) throw e;
          failures += 1;
          if (!(primary.dead?.() ?? true) && failures < FAILURES_BEFORE_FALLBACK) throw e;
          console.warn("OCR failed, reading with the fallback from now on", e);
          failedOver = true;
        }
      }
      // A fallback that failed to start (a download that failed, say) is tried again next read.
      second ??= backup().catch((e: unknown) => {
        second = null;
        throw e;
      });
      return (await second).read(img, opts);
    },
    async terminate() {
      closed = true;
      await primary.terminate();
      await (await second?.catch(() => null))?.terminate();
    },
  };
}

/** `tesseract`: where the app serves Tesseract's files (scripts/copy-ocr.mjs). */
export async function createScannerOcr(tesseract: TesseractPaths): Promise<ScannerOcr> {
  if (Capacitor.isNativePlatform()) {
    const mlkit = await createMlKitOcr();
    if (mlkit) return { ...mlkit, engine: "mlkit", terminate: async () => {} };
  }
  const dir: string = import.meta.env.VITE_PADDLE_DIR ?? "";
  if (dir) {
    let paddle: WorkerOcr | null = null;
    try {
      paddle = await createPaddleWorkerOcr(dir);
    } catch (e) {
      console.warn("Browser OCR unavailable, reading with Tesseract", e);
    }
    if (paddle) return { ...withFallback(paddle, () => createTesseractOcr(tesseract)), engine: "paddle" };
  }
  const t = await createTesseractOcr(tesseract);
  return { read: (img, opts) => t.read(img, opts), engine: "tesseract", terminate: () => t.terminate() };
}
