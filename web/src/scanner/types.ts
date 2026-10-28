// Public types for the scanner. The pipeline is pure: an image goes in, ranked candidates come
// out. OCR and the card catalog are injected, so the same code runs in the browser, in a
// Capacitor web view, and in Node for the eval harness.

export type Point = [number, number];
/** Card corners in image pixels, printed order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

/** Same shape as the DOM's ImageData, so a canvas frame can be passed straight in. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** One byte per pixel. */
export interface Gray {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface OcrResult {
  text: string;
  /** 0..100, Tesseract's mean word confidence. */
  confidence: number;
}

/** Anything that can read one line or block of text from a prepared grey crop. */
export interface OcrEngine {
  /**
   * `mode` "line" is a single text line; "block" is a small block (the two-line collector info).
   * `whitelist` limits the characters Tesseract may return.
   */
  read(img: Gray, opts: { mode: "line" | "block"; whitelist?: string }): Promise<OcrResult>;
}

/** What the scanner needs to know about the card database. */
export interface ScanCatalog {
  /** Lowercase set codes that exist (e.g. "mom", "ecc", "plst"). Used to fix OCR confusions. */
  hasSet(code: string): boolean;
  /** One printing by set and collector number, or null if there is none. */
  lookup(set: string, number: string, lang: string): Promise<CatalogPrinting | null>;
  /** Every card name, for the name fallback. Faces of multi-face cards are listed separately. */
  names(): readonly string[];
  /** Map a matched (face) name to the card's full name, if they differ. */
  fullName?(name: string): string;
  /**
   * Every printing of the named card (full name). Lets a clearly read title plus part of the
   * collector line pin the printing when the line itself was misread. See `pickPrinting`.
   */
  printingsOf?(name: string): Promise<CatalogPrinting[]>;
}

export interface CatalogPrinting {
  scryfall_id?: string;
  name: string;
  set: string;
  number: string;
  lang: string;
  image?: string | null;
}

/**
 * How the card was recognised: by its artwork ("art"), or by reading text: the collector line
 * and title together, the collector line alone, or the title alone ("name", which settles no printing).
 */
export type ScanMethod = "art" | "collector" | "collector+name" | "name";

export interface ScanCandidate {
  /** Card name as the catalog spells it. */
  name: string;
  /** Present once the printing is settled (read from the card, or picked). */
  set?: string;
  number?: string;
  lang?: string;
  scryfall_id?: string;
  image?: string | null;
  /** The small picture, for lists. */
  thumb?: string | null;
  /** 0..1. Above ~0.8 is safe to accept without a tap; see docs/scanner.md. */
  confidence: number;
  method: ScanMethod;
}

export interface ScanTimings {
  totalMs: number;
  locateMs: number;
  collectorOcrMs: number;
  nameOcrMs: number;
  matchMs: number;
}

export interface ScanResult {
  /** Best first. Empty when nothing was recognised. */
  candidates: ScanCandidate[];
  /** Where the card was found in the frame. */
  quad: Quad;
  /** What OCR read, for debugging and for the "not this card" sheet. */
  raw: { collector: string; name: string };
  timings: ScanTimings;
}
