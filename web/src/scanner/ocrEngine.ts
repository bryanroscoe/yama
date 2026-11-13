// Which OCR engine the scanner uses: ML Kit inside the Android app, Tesseract elsewhere (and in
// the app if its native code has no text reader).

import { Capacitor } from "@capacitor/core";
import { createMlKitOcr } from "./mlkit";
import { createTesseractOcr, type TesseractPaths } from "./tesseract";
import type { OcrEngine } from "./types";

export interface ScannerOcr extends OcrEngine {
  /** Which engine this is, for the scanner's diagnostics. */
  engine: "mlkit" | "tesseract";
  terminate(): Promise<void>;
}

export async function createScannerOcr(tesseract: TesseractPaths): Promise<ScannerOcr> {
  if (Capacitor.isNativePlatform()) {
    const mlkit = await createMlKitOcr();
    if (mlkit) return { ...mlkit, engine: "mlkit", terminate: async () => {} };
  }
  const t = await createTesseractOcr(tesseract);
  return { read: (img, opts) => t.read(img, opts), engine: "tesseract", terminate: () => t.terminate() };
}
