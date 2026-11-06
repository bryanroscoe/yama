// Frame in, ranked card candidates out. See docs/scanner.md for why this is OCR-first.
//
//   frame ─▶ grey ─▶ card quad (guide frame, snapped to the card's edges when they are clear)
//         ─▶ collector line crop ─▶ OCR ─▶ set + number ─▶ catalog lookup
//         ─▶ title crop ─────────▶ OCR ─▶ fuzzy name match (checks the lookup; fallback for old cards)

import { fittingDistance, NameIndex } from "./fuzzy";
import { cropToTextBand, prepareText, toGray, warpRegion, type CardRegion } from "./image";
import { refineQuad } from "./locate";
import { normaliseName, parseCollector } from "./parse";
import { pickPrinting } from "./pick";
import type { CatalogPrinting, Gray, OcrEngine, OcrResult, Quad, RgbaImage, ScanCandidate, ScanCatalog, ScanResult } from "./types";

/** Bottom-left collector block (two lines) on 2015+ frames, with room for a misaligned card. */
export const COLLECTOR_REGION: CardRegion = { x0: 0.03, y0: 0.91, x1: 0.5, y1: 0.99 };
/**
 * The same corner cut wider and down to the card's edge: the detector's corners can sit a little
 * inside the card, and on borderless and older frames the line runs lower or further right.
 */
export const WIDE_COLLECTOR_REGION: CardRegion = { x0: 0.01, y0: 0.88, x1: 0.62, y1: 1 };
/** Title bar, stopping before most mana costs. The text band inside is found per crop. */
export const NAME_REGION: CardRegion = { x0: 0.05, y0: 0.03, x1: 0.8, y1: 0.125 };
/** Tighter title crop, tried when the first read matched nothing (busy old frames). */
export const ALT_NAME_REGION: CardRegion = { x0: 0.07, y0: 0.04, x1: 0.72, y1: 0.11 };

/** Pixels per card height at which each crop is sampled for OCR. */
const COLLECTOR_DENSITY = 2400;
const NAME_DENSITY = 1200;

const COLLECTOR_WHITELIST = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•*-+ ";

/** Accept without asking at or above this confidence. */
export const SURE = 0.8;

export interface ScanOptions {
  ocr: OcrEngine;
  catalog: ScanCatalog;
  /** Build once with `new NameIndex(catalog.names())` and reuse it across frames. */
  names: NameIndex;
  /** Where the on-screen guide puts the card, in frame pixels. */
  guide: Quad;
  /** Snap the guide to the card's actual edges when they are clear. Default true. */
  refine?: boolean;
  /** Retry upside down when nothing sure was found. Default true. */
  tryUpsideDown?: boolean;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function crop(gray: Gray, quad: Quad, r: CardRegion, density: number, band: boolean): Gray {
  const h = Math.round((r.y1 - r.y0) * density);
  const w = Math.round(((r.x1 - r.x0) * density * 63) / 88);
  const g = prepareText(warpRegion(gray, quad, r, w, h), band ? 0 : 12);
  return band ? prepareText(cropToTextBand(g)) : g;
}

/** How well OCR'd title text matches a card name (any face). 0..1. */
export function nameAgreement(cardName: string, ocrText: string): number {
  const text = normaliseName(ocrText);
  if (!text) return 0;
  let best = 0;
  for (const face of cardName.split(" // ")) {
    const n = normaliseName(face);
    if (!n) continue;
    best = Math.max(best, 1 - fittingDistance(n, text) / n.length);
  }
  return best;
}

const fromPrinting = (p: CatalogPrinting, confidence: number, method: ScanCandidate["method"]): ScanCandidate => ({
  name: p.name,
  set: p.set,
  number: p.number,
  lang: p.lang,
  scryfall_id: p.scryfall_id,
  image: p.image,
  confidence,
  method,
});

/** Turn the two OCR reads into ranked candidates. Exported for tests. */
export async function decide(collectorText: string, nameText: string, opts: Pick<ScanOptions, "catalog" | "names">): Promise<ScanCandidate[]> {
  const { catalog } = opts;
  const read = parseCollector(collectorText, (c) => catalog.hasSet(c));
  let printing: CatalogPrinting | null = null;
  let strong = false;
  outer: for (const set of read.sets.slice(0, 3)) {
    for (const number of read.numbers.slice(0, 3)) {
      printing = await catalog.lookup(set, number, read.lang);
      if (printing) {
        strong = read.anchored && read.exactSets.includes(set) && read.strongNumbers.includes(number);
        break outer;
      }
    }
  }
  const agree = printing && nameText ? nameAgreement(printing.name, nameText) : 0;
  if (printing && agree >= 0.7) return [fromPrinting(printing, 0.97, "collector+name")];

  const matches = nameText ? opts.names.match(nameText, 3) : [];
  const top = matches[0];
  const margin = top ? top.score - (matches[1]?.score ?? 0) : 0;
  const topName = top ? (catalog.fullName?.(top.name) ?? top.name) : null;
  const nameSure = !!top && top.score >= 0.8 && margin >= 0.05;

  // A clear title plus part of the collector line (set code with a misread number, a
  // misread set code with a good number, or the "59/274" of 2003-2014 frames, which print no
  // set code) can still pin the printing.
  if (top && topName && top.score >= 0.7 && catalog.printingsOf && (read.rawSets.length > 0 || read.numbers.length > 0)) {
    const pick = pickPrinting(await catalog.printingsOf(topName), read.sets.slice(0, 3), read.numbers.slice(0, 3), read.rawSets);
    if (pick) return [fromPrinting(pick.printing, nameSure ? (pick.how === "set" ? 0.9 : 0.8) : 0.6, "collector+name")];
  }

  const nameCandidate = (): ScanCandidate | null =>
    top && topName && top.score >= 0.6
      ? { name: topName, confidence: Math.min(0.9, top.score * (margin > 0.1 ? 0.95 : 0.75)), method: "name" }
      : null;

  if (printing) {
    // The title read clearly as a different card: the number was probably misread.
    if (nameSure && agree < 0.5) {
      const other = nameCandidate();
      return other ? [{ ...other, confidence: Math.min(other.confidence, 0.6) }, fromPrinting(printing, 0.3, "collector")] : [];
    }
    // Title unreadable (sideways battles, busy frames): the collector line alone.
    return [fromPrinting(printing, strong ? 0.85 : 0.5, "collector")];
  }
  const byName = nameCandidate();
  return byName ? [byName] : [];
}

/**
 * OCR of the collector line alone, for a card whose quad is already known (the art recognizer's).
 * The quad is snapped to the card's edges first when they are clear.
 */
export async function readCollectorLine(frame: RgbaImage, quad: Quad, ocr: OcrEngine): Promise<string> {
  for await (const text of readCollectorLines(frame, quad, ocr)) return text;
  return "";
}

/**
 * Reads of the collector line, one crop at a time, for a caller that stops at the first read that
 * settles the printing: the usual corner at the card's snapped edges, then at the detector's own
 * corners (when snapping moved them), then the corner cut wider, to the card's edge, with no band
 * clean-up (a line at the very edge, or a frame that puts it lower).
 */
export async function* readCollectorLines(frame: RgbaImage, quad: Quad, ocr: OcrEngine): AsyncGenerator<string> {
  const gray = toGray(frame);
  const refined = refineQuad(gray, quad);
  const q = refined ?? quad;
  const read = async (at: Quad, region: CardRegion, pad: number) =>
    (await ocr.read(prepareText(warpRegion(gray, at, region, Math.round(((region.x1 - region.x0) * COLLECTOR_DENSITY * 63) / 88), Math.round((region.y1 - region.y0) * COLLECTOR_DENSITY)), pad), { mode: "block", whitelist: COLLECTOR_WHITELIST })).text;
  yield await read(q, COLLECTOR_REGION, 12);
  if (refined) yield await read(quad, COLLECTOR_REGION, 12);
  yield await read(q, WIDE_COLLECTOR_REGION, 16);
}

/**
 * OCR of a close-up: the person holds the camera close to the collector line or the title and
 * the image is just the box they lined it up in. Collector boxes should be about 200 px tall,
 * title boxes about 110 px (the densities `scanFrame` samples at).
 */
export async function readCloseup(image: RgbaImage, kind: "collector" | "title", ocr: OcrEngine): Promise<string> {
  const gray = toGray(image);
  if (kind === "collector") return (await ocr.read(prepareText(gray, 12), { mode: "block", whitelist: COLLECTOR_WHITELIST })).text;
  // The box holds the title bar with the card's frame and art around it, so the majority of the
  // box is the wrong guide to which way the text runs. Read the middle, where the name sits,
  // leaving out the mana cost at the right.
  const mid = cropGray(gray, 0.02, 0.2, 0.8, 0.8);
  const banded = (await ocr.read(prepareText(cropToTextBand(prepareText(mid, 0))), { mode: "line" })).text;
  const letters = (t: string) => t.replace(/[^A-Za-z]/g, "").length >= 3;
  if (letters(banded)) return banded;
  const plain = (await ocr.read(prepareText(mid, 12), { mode: "line" })).text;
  if (letters(plain)) return plain;
  // A box framed loosely around the name: find the text band in all of it.
  return (await ocr.read(prepareText(cropToTextBand(prepareText(gray, 0))), { mode: "line" })).text;
}

/** Part of a grey image, by fractions of its width and height. */
function cropGray(g: Gray, x0: number, y0: number, x1: number, y1: number): Gray {
  const left = Math.round(g.width * x0);
  const top = Math.round(g.height * y0);
  const w = Math.max(1, Math.round(g.width * x1) - left);
  const h = Math.max(1, Math.round(g.height * y1) - top);
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y += 1) data.set(g.data.subarray((top + y) * g.width + left, (top + y) * g.width + left + w), y * w);
  return { width: w, height: h, data };
}

interface Attempt {
  candidates: ScanCandidate[];
  collector: OcrResult;
  name: OcrResult;
  quad: Quad;
}

const bestConfidence = (a: Attempt | null) => a?.candidates[0]?.confidence ?? 0;

/** Recognise the card in one camera frame. */
export async function scanFrame(frame: RgbaImage, opts: ScanOptions): Promise<ScanResult> {
  const t0 = now();
  const gray = toGray(frame);
  const quad = opts.refine === false ? opts.guide : (refineQuad(gray, opts.guide) ?? opts.guide);
  const t1 = now();
  let collectorMs = 0;
  let nameMs = 0;
  let matchMs = 0;

  const attempt = async (q: Quad): Promise<Attempt> => {
    const a = now();
    const collectorP = opts.ocr.read(crop(gray, q, COLLECTOR_REGION, COLLECTOR_DENSITY, false), { mode: "block", whitelist: COLLECTOR_WHITELIST });
    const nameP = opts.ocr.read(crop(gray, q, NAME_REGION, NAME_DENSITY, true), { mode: "line" });
    const collector = await collectorP;
    const b = now();
    let name = await nameP;
    nameMs += now() - b;
    collectorMs += b - a;
    let m = now();
    let candidates = await decide(collector.text, name.text, opts);
    matchMs += now() - m;
    if ((candidates[0]?.confidence ?? 0) < SURE) {
      const c = now();
      const alt = await opts.ocr.read(crop(gray, q, ALT_NAME_REGION, NAME_DENSITY, true), { mode: "line" });
      nameMs += now() - c;
      m = now();
      const altCandidates = await decide(collector.text, alt.text, opts);
      matchMs += now() - m;
      if ((altCandidates[0]?.confidence ?? 0) > (candidates[0]?.confidence ?? 0)) {
        candidates = altCandidates;
        name = alt;
      }
    }
    return { candidates, collector, name, quad: q };
  };

  let best = await attempt(quad);
  if (bestConfidence(best) < SURE && opts.tryUpsideDown !== false) {
    const flipped = await attempt([quad[2], quad[3], quad[0], quad[1]]);
    if (bestConfidence(flipped) > bestConfidence(best)) best = flipped;
  }
  return {
    candidates: best.candidates,
    quad: best.quad,
    raw: { collector: best.collector.text, name: best.name.text },
    timings: { totalMs: now() - t0, locateMs: t1 - t0, collectorOcrMs: collectorMs, nameOcrMs: nameMs, matchMs },
  };
}
