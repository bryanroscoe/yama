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
  /** The engine picked at the start, for the scanner's diagnostics ("paddle" may have fallen back to Tesseract since). */
  engine: "mlkit" | "paddle" | "tesseract";
}

/** What each engine is called in Scan settings. */
export const ENGINE_LABEL: Record<ScannerOcr["engine"], string> = {
  mlkit: "Google ML Kit, on this device",
  paddle: "PaddleOCR (PP-OCRv5), in the browser",
  tesseract: "Tesseract, in the browser",
};

type Engine = ScannerOcr["engine"];

/** The text readers this build has on this device: ML Kit only in the Android app, PaddleOCR only when the build has its models. */
export function availableEngines(): Engine[] {
  return [...(Capacitor.isNativePlatform() ? (["mlkit"] as const) : []), ...(import.meta.env.VITE_PADDLE_DIR ? (["paddle"] as const) : []), "tesseract"];
}

/**
 * Which reader to start (the text slot in Scan settings, models.ts): "auto" or one engine, and the
 * engines the server offers (`allowed`; one it has withdrawn is skipped by "auto"). Tesseract is
 * always there to fall back to.
 */
export interface OcrChoice {
  engine?: "auto" | Engine;
  allowed?: readonly string[];
}

/**
 * The engines to try, in order, for a choice: the chosen one first, then what "auto" would pick,
 * ending with Tesseract, the last resort whatever is withdrawn (it needs nothing but the app).
 */
export function engineOrder(choice: OcrChoice = {}, available: readonly Engine[] = availableEngines()): Engine[] {
  const allowed = (e: Engine) => available.includes(e) && (!choice.allowed || choice.allowed.includes(e));
  const auto = (["mlkit", "paddle"] as const).filter(allowed);
  const first = choice.engine && choice.engine !== "auto" && allowed(choice.engine) ? [choice.engine] : [];
  return [...new Set<Engine>([...first, ...auto, "tesseract"])];
}

/** The engine createScannerOcr will most likely pick, before it has started (ML Kit or PaddleOCR can still fall through). */
export function plannedEngine(choice: OcrChoice = {}): Engine {
  return engineOrder(choice)[0]!;
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

/** `tesseract`: where the app serves Tesseract's files (scripts/copy-ocr.mjs). `choice`: the text slot's (models.ts). */
export async function createScannerOcr(tesseract: TesseractPaths, choice: OcrChoice = {}): Promise<ScannerOcr> {
  for (const engine of engineOrder(choice)) {
    if (engine === "mlkit") {
      const mlkit = await createMlKitOcr();
      if (mlkit) return { ...mlkit, engine: "mlkit", terminate: async () => {} };
    } else if (engine === "paddle") {
      let paddle: WorkerOcr | null = null;
      try {
        paddle = await createPaddleWorkerOcr(import.meta.env.VITE_PADDLE_DIR ?? "");
      } catch (e) {
        console.warn("Browser OCR unavailable, reading with Tesseract", e);
      }
      if (paddle) return { ...withFallback(paddle, () => createTesseractOcr(tesseract)), engine: "paddle" };
    } else break;
  }
  const t = await createTesseractOcr(tesseract);
  return { read: (img, opts) => t.read(img, opts), engine: "tesseract", terminate: () => t.terminate() };
}
