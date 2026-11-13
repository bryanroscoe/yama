// OcrEngine backed by Google's ML Kit text recognition, inside the Android app only
// (TextReaderPlugin.java). It reads the same grey crops as Tesseract, on the device, with the
// model bundled in the APK. Tesseract stays the engine everywhere else.

import { registerPlugin } from "@capacitor/core";
import type { Gray, OcrEngine, OcrResult } from "./types";

export interface MlKitLine {
  text: string;
  /** 0 to 1. */
  confidence: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

interface TextReader {
  available(): Promise<{ available: boolean }>;
  read(o: { width: number; height: number; data: string }): Promise<{ lines: MlKitLine[]; ms: number }>;
}

const TextReader = registerPlugin<TextReader>("TextReader");

/** Base64 of the grey bytes, in chunks (a single spread of a large array overflows the stack). */
export function greyToBase64(img: Gray): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < img.data.length; i += step) s += String.fromCharCode(...img.data.subarray(i, i + step));
  return btoa(s);
}

/**
 * ML Kit's lines as one result, in reading order: pieces on one printed row are joined with a
 * space, left to right, and rows with a newline for a block or a space for a single line. As
 * Tesseract's whitelist would, characters outside `whitelist` are dropped (after raising lower
 * case if the whitelist has none). Confidence is the
 * length-weighted mean, on Tesseract's 0 to 100 scale.
 */
export function combineLines(lines: readonly MlKitLine[], opts: { mode: "line" | "block"; whitelist?: string }): OcrResult {
  const allowed = opts.whitelist ? new Set(opts.whitelist) : null;
  // ML Kit reads case as printed ("WOC•EN DAN ScoTT"); Tesseract held to a capitals-only
  // whitelist reads capitals, so lower case is raised rather than dropped.
  const upper = !!opts.whitelist && opts.whitelist === opts.whitelist.toUpperCase();
  const clean = (t: string) => (allowed ? [...(upper ? t.toUpperCase() : t)].filter((c) => allowed.has(c) || c === " ").join("") : t).replace(/\s+/g, " ").trim();
  // Physical rows, top to bottom; pieces ML Kit split on one printed line ("MOM" and "• EN") stay
  // on one row, left to right, so the set code keeps its language beside it.
  const rows: MlKitLine[][] = [];
  for (const l of [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0))) {
    const mid = ((l.top ?? 0) + (l.bottom ?? 0)) / 2;
    const row = rows.find((r) => r.some((o) => mid > (o.top ?? 0) && mid < (o.bottom ?? 0)));
    if (row) row.push(l);
    else rows.push([l]);
  }
  const kept: { text: string; confidence: number }[] = [];
  const rowTexts: string[] = [];
  for (const row of rows) {
    const parts = row
      .sort((a, b) => (a.left ?? 0) - (b.left ?? 0))
      .map((l) => ({ text: clean(l.text), confidence: l.confidence }))
      .filter((l) => l.text);
    if (!parts.length) continue;
    kept.push(...parts);
    rowTexts.push(parts.map((p) => p.text).join(" "));
  }
  const text = rowTexts.join(opts.mode === "block" ? "\n" : " ");
  const weight = kept.reduce((n, l) => n + l.text.length, 0);
  const confidence = weight ? (100 * kept.reduce((n, l) => n + l.confidence * l.text.length, 0)) / weight : 0;
  return { text, confidence };
}

/** The ML Kit engine, or null when this isn't the app or its native code has no text reader (an older APK). */
export async function createMlKitOcr(): Promise<OcrEngine | null> {
  try {
    if (!(await TextReader.available()).available) return null;
  } catch {
    return null;
  }
  return {
    async read(img, opts) {
      const { lines } = await TextReader.read({ width: img.width, height: img.height, data: greyToBase64(img) });
      return combineLines(lines, opts);
    },
  };
}
