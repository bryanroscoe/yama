// OcrEngine on PaddleOCR's PP-OCRv5 English text recogniser (Apache-2.0), run by ONNX Runtime
// (passed in, so the same code runs in the OCR web worker and in Node for the evals).
// See docs/scanner.md, "Browser OCR: PP-OCRv5 (2026-11-13)".
//
// Two models: a small text detector (PP-OCRv3 mobile det) finds the words in the crop as turned
// boxes, which are grouped into lines; the recogniser reads each line in one run, straightened and
// scaled to 48 px high. A "line" read keeps the line with the most text (the title); a "block" (the two-line
// collector info) keeps every line, top to bottom. When the detector finds nothing, the crop is
// split into lines by rows of ink instead.
//
// Pure parts (detector post-processing, line finding, input tensors, CTC decoding with a
// whitelist) are exported for tests.

import type { Gray, OcrEngine, OcrResult } from "./types";

/** The recogniser's input height. */
export const REC_HEIGHT = 48;
/** Widest input, in model pixels (the model divides width by 8 into time steps). */
const MAX_WIDTH = 1600;

export interface OrtLike {
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => unknown;
}
export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}

/**
 * The model's classes: 0 is the CTC blank, then one per line of the dictionary, then a space
 * (PaddleOCR's `use_space_char`).
 */
export function classesFromDict(dict: string): string[] {
  const chars = dict.split(/\r?\n/);
  if (chars[chars.length - 1] === "") chars.pop();
  return ["", ...chars, " "];
}

/** A band of rows holding a line of text: [top, bottom) and how much ink it holds. */
export interface Band {
  top: number;
  bottom: number;
  ink: number;
}

/** Darkness threshold: the midpoint of the image's 5th and 95th percentile. */
function inkThreshold(g: Gray): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.data.length; i += 1) hist[g.data[i]!]! += 1;
  const lo = g.data.length * 0.05;
  const hi = g.data.length * 0.95;
  let acc = 0;
  let p5 = 0;
  let p95 = 255;
  for (let v = 0; v < 256; v += 1) {
    acc += hist[v]!;
    if (acc <= lo) p5 = v;
    if (acc <= hi) p95 = v;
  }
  return p95 - p5 < 40 ? -1 : (p5 + p95) / 2;
}

/**
 * Text lines in a crop of dark text on a light ground (what `prepareText` makes), top to bottom.
 * Rows that are nearly all ink (a card's edge or a frame line) aren't text and split bands; bands
 * much shorter than the tallest (specks, the bottom of a letter cut by the crop) are dropped.
 */
export function findLines(g: Gray): Band[] {
  const t = inkThreshold(g);
  if (t < 0) return [];
  const rows = new Float32Array(g.height);
  for (let y = 0; y < g.height; y += 1) {
    let n = 0;
    for (let x = 0; x < g.width; x += 1) if (g.data[y * g.width + x]! < t) n += 1;
    // Solid rules aren't text.
    rows[y] = n > g.width * 0.6 ? 0 : n;
  }
  let max = 0;
  for (let y = 0; y < g.height; y += 1) max = Math.max(max, rows[y]!);
  if (max < 3) return [];
  const on = Math.max(2, max * 0.08);
  const bands: Band[] = [];
  let cur: Band | null = null;
  for (let y = 0; y < g.height; y += 1) {
    if (rows[y]! >= on) {
      if (cur) {
        cur.bottom = y + 1;
        cur.ink += rows[y]!;
      } else cur = { top: y, bottom: y + 1, ink: rows[y]! };
    } else if (cur) {
      bands.push(cur);
      cur = null;
    }
  }
  if (cur) bands.push(cur);
  // Close tiny gaps inside a line (a thin stroke row under the threshold).
  const merged: Band[] = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.top - last.bottom <= 1) {
      last.bottom = b.bottom;
      last.ink += b.ink;
    } else merged.push({ ...b });
  }
  const tallest = Math.max(0, ...merged.map((b) => b.bottom - b.top));
  return merged.filter((b) => b.bottom - b.top >= Math.max(4, tallest * 0.35));
}

/** Columns with ink in rows [top, bottom), as [left, right). Null when there is none. */
function inkColumns(g: Gray, top: number, bottom: number, t: number): [number, number] | null {
  let left = -1;
  let right = -1;
  for (let x = 0; x < g.width; x += 1) {
    let n = 0;
    for (let y = top; y < bottom; y += 1) if (g.data[y * g.width + x]! < t) n += 1;
    // A column of solid ink across the whole band is the card's edge, not text.
    if (n > 0 && n < (bottom - top) * 0.95) {
      if (left < 0) left = x;
      right = x + 1;
    }
  }
  return left < 0 ? null : [left, right];
}

/** A text line found by the detector: centre, direction (radians) and half extents. */
export interface TextBox {
  cx: number;
  cy: number;
  angle: number;
  halfW: number;
  halfH: number;
  score: number;
}

/**
 * The recogniser's input for an oriented box: sampled along the box (so a slightly turned line
 * comes out level), 48 px high, as a [1, 3, 48, W] tensor in [-1, 1].
 */
export function boxTensor(g: Gray, b: TextBox): { data: Float32Array; width: number } {
  const width = Math.max(16, Math.min(MAX_WIDTH, Math.round((b.halfW * REC_HEIGHT) / b.halfH)));
  const plane = width * REC_HEIGHT;
  const data = new Float32Array(3 * plane);
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  for (let y = 0; y < REC_HEIGHT; y += 1) {
    const v = ((y + 0.5) / REC_HEIGHT) * 2 * b.halfH - b.halfH;
    for (let x = 0; x < width; x += 1) {
      const u = ((x + 0.5) / width) * 2 * b.halfW - b.halfW;
      const n = sample(g, b.cx + u * cos - v * sin, b.cy + u * sin + v * cos) / 127.5 - 1;
      const i = y * width + x;
      data[i] = n;
      data[plane + i] = n;
      data[2 * plane + i] = n;
    }
  }
  return { data, width };
}

/** Bilinear sample at pixel-centre coordinates; outside the image is white (the ground). */
function sample(g: Gray, fx: number, fy: number): number {
  const x = fx - 0.5;
  const y = fy - 0.5;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ax = x - ix;
  const ay = y - iy;
  const px = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= g.width || cy >= g.height ? 255 : g.data[cy * g.width + cx]!);
  return (px(ix, iy) * (1 - ax) + px(ix + 1, iy) * ax) * (1 - ay) + (px(ix, iy + 1) * (1 - ax) + px(ix + 1, iy + 1) * ax) * ay;
}

/** The detector's input: the crop resized to multiples of 32 (at most 960 wide), ImageNet-normalised. */
export function detTensor(g: Gray): { data: Float32Array; width: number; height: number } {
  const scale = Math.min(1, 960 / Math.max(g.width, g.height));
  const width = Math.max(32, Math.round((g.width * scale) / 32) * 32);
  const height = Math.max(32, Math.round((g.height * scale) / 32) * 32);
  const plane = width * height;
  const data = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const sx = g.width / width;
  const sy = g.height / height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = sample(g, (x + 0.5) * sx, (y + 0.5) * sy) / 255;
      const i = y * width + x;
      for (let c = 0; c < 3; c += 1) data[c * plane + i] = (v - mean[c]!) / std[c]!;
    }
  }
  return { data, width, height };
}

/**
 * Text boxes from the detector's probability map (DB post-processing, simplified): pixels over
 * 0.3 form regions; a region whose mean probability is under 0.6 or that is too small is dropped;
 * each region's direction comes from its pixels' principal axis, and the box is grown by DB's
 * unclip distance (area x 1.5 / perimeter). Coordinates are scaled back by `sx`, `sy`.
 */
export function boxesFromMap(prob: Float32Array, width: number, height: number, sx: number, sy: number): TextBox[] {
  const seen = new Uint8Array(width * height);
  const boxes: TextBox[] = [];
  const stack: number[] = [];
  const pts: number[] = [];
  for (let start = 0; start < prob.length; start += 1) {
    if (seen[start] || prob[start]! <= 0.3) continue;
    seen[start] = 1;
    stack.push(start);
    pts.length = 0;
    let sum = 0;
    while (stack.length) {
      const i = stack.pop()!;
      pts.push(i);
      sum += prob[i]!;
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!seen[j] && prob[j]! > 0.3) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (pts.length < 12 || sum / pts.length < 0.6) continue;
    // Principal axis, in original-image pixels.
    let mx = 0;
    let my = 0;
    for (const i of pts) {
      mx += ((i % width) + 0.5) * sx;
      my += (Math.floor(i / width) + 0.5) * sy;
    }
    mx /= pts.length;
    my /= pts.length;
    let cxx = 0;
    let cyy = 0;
    let cxy = 0;
    for (const i of pts) {
      const dx = ((i % width) + 0.5) * sx - mx;
      const dy = (Math.floor(i / width) + 0.5) * sy - my;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }
    let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    // Lines run roughly left to right; anything steeper is read as level.
    if (Math.abs(angle) > Math.PI / 12) angle = 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const i of pts) {
      const x = i % width;
      const y = Math.floor(i / width);
      // The pixel's corners, so a region one pixel thick still has extent.
      for (const [ox, oy] of CORNERS) {
        const dx = (x + ox) * sx - mx;
        const dy = (y + oy) * sy - my;
        const u = dx * cos + dy * sin;
        const v = -dx * sin + dy * cos;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
    }
    const w = u1 - u0;
    const h = v1 - v0;
    if (h < 3 || w < 3) continue;
    const d = (w * h * 1.5) / (2 * (w + h));
    const cu = (u0 + u1) / 2;
    const cv = (v0 + v1) / 2;
    boxes.push({ cx: mx + cu * cos - cv * sin, cy: my + cu * sin + cv * cos, angle, halfW: w / 2 + d, halfH: h / 2 + d, score: sum / pts.length });
  }
  return boxes;
}

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const CORNER_SIGNS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const CORNERS: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * Boxes grouped into lines, top to bottom, each line's boxes left to right: boxes whose centres
 * are within half a box height of each other (along the line's direction) share a line.
 */
export function groupLines(boxes: TextBox[]): TextBox[][] {
  const sorted = [...boxes].sort((a, b) => a.cy - b.cy);
  const lines: TextBox[][] = [];
  for (const b of sorted) {
    const line = lines.find((l) => {
      // The widest box so far: a short word's direction is mostly noise.
      const a = l.reduce((w, x) => (x.halfW > w.halfW ? x : w));
      // Where the line's centre line is at this box's x.
      const yAt = a.cy + Math.tan(a.angle) * (b.cx - a.cx);
      return Math.abs(b.cy - yAt) < Math.max(a.halfH, b.halfH) * 0.6;
    });
    if (line) line.push(b);
    else lines.push([b]);
  }
  for (const l of lines) l.sort((a, b) => a.cx - b.cx);
  return lines.sort((a, b) => a[0]!.cy - b[0]!.cy);
}

/**
 * One box around a line's boxes, along the first box's direction: the recogniser reads the whole
 * line in one run (faster than a run per word, and it sees the gaps as spaces).
 */
export function mergeLine(line: TextBox[]): TextBox {
  if (line.length === 1) return line[0]!;
  // Weighted by length: a short word's ("C", "EN") direction is mostly noise.
  const weight = line.reduce((a, b) => a + b.halfW * b.halfW, 0);
  const angle = line.reduce((a, b) => a + b.angle * b.halfW * b.halfW, 0) / weight;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const o = line[0]!;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  // Each box's corners in the merged box's frame, so a box turned differently still fits.
  for (const b of line) {
    const bc = Math.cos(b.angle);
    const bs = Math.sin(b.angle);
    for (const [su, sv] of CORNER_SIGNS) {
      const x = b.cx + su * b.halfW * bc - sv * b.halfH * bs - o.cx;
      const y = b.cy + su * b.halfW * bs + sv * b.halfH * bc - o.cy;
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  return { cx: o.cx + cu * cos - cv * sin, cy: o.cy + cu * sin + cv * cos, angle, halfW: (u1 - u0) / 2, halfH: (v1 - v0) / 2, score: Math.min(...line.map((b) => b.score)) };
}

/**
 * The recogniser's input for rows [top, bottom) of a grey crop: cut to the ink with a margin,
 * scaled to 48 px high (bilinear), as a [1, 3, 48, W] tensor in [-1, 1].
 */
export function lineTensor(g: Gray, top: number, bottom: number): { data: Float32Array; width: number } {
  const t = inkThreshold(g);
  const cols = t < 0 ? null : inkColumns(g, top, bottom, t);
  const h0 = bottom - top;
  // PaddleOCR's training crops leave a little room around the text.
  const vm = Math.round(h0 * 0.25);
  const y0 = Math.max(0, top - vm);
  const y1 = Math.min(g.height, bottom + vm);
  const x0 = Math.max(0, (cols?.[0] ?? 0) - vm);
  const x1 = Math.min(g.width, (cols?.[1] ?? g.width) + vm);
  const sh = y1 - y0;
  const sw = x1 - x0;
  const width = Math.max(16, Math.min(MAX_WIDTH, Math.round((sw * REC_HEIGHT) / sh)));
  const plane = width * REC_HEIGHT;
  const data = new Float32Array(3 * plane);
  const sx = sw / width;
  const sy = sh / REC_HEIGHT;
  for (let y = 0; y < REC_HEIGHT; y += 1) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const iy = Math.floor(fy);
    const ay = fy - iy;
    const r0 = (y0 + iy) * g.width;
    const r1 = (y0 + Math.min(sh - 1, iy + 1)) * g.width;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const ix = Math.floor(fx);
      const ax = fx - ix;
      const c0 = x0 + ix;
      const c1 = x0 + Math.min(sw - 1, ix + 1);
      const v =
        (g.data[r0 + c0]! * (1 - ax) + g.data[r0 + c1]! * ax) * (1 - ay) + (g.data[r1 + c0]! * (1 - ax) + g.data[r1 + c1]! * ax) * ay;
      const n = v / 127.5 - 1;
      const i = y * width + x;
      data[i] = n;
      data[plane + i] = n;
      data[2 * plane + i] = n;
    }
  }
  return { data, width };
}

/**
 * Greedy CTC decoding of the model's per-step class probabilities ([steps, classes], softmaxed).
 * With `allowed`, only those classes (and the blank) can win a step, like Tesseract's whitelist.
 * Confidence is the mean probability of the kept characters, 0..1 (0 when none).
 */
export function ctcDecode(probs: Float32Array, steps: number, classes: string[], allowed?: Uint8Array): { text: string; confidence: number } {
  const n = classes.length;
  let text = "";
  let sum = 0;
  let kept = 0;
  let prev = 0;
  for (let s = 0; s < steps; s += 1) {
    const row = s * n;
    let best = 0;
    let bestP = probs[row]!;
    for (let c = 1; c < n; c += 1) {
      const p = probs[row + c]!;
      if (p > bestP && (!allowed || allowed[c])) {
        best = c;
        bestP = p;
      }
    }
    if (best !== 0 && best !== prev) {
      text += classes[best];
      sum += bestP;
      kept += 1;
    }
    prev = best;
  }
  return { text: text.replace(/ {2,}/g, " ").trim(), confidence: kept ? sum / kept : 0 };
}

/** Which classes a whitelist lets through (the blank always). */
export function allowedClasses(classes: string[], whitelist: string): Uint8Array {
  const set = new Set(whitelist);
  const out = new Uint8Array(classes.length);
  out[0] = 1;
  classes.forEach((c, i) => {
    if (i > 0 && set.has(c)) out[i] = 1;
  });
  return out;
}

/** Combine per-line reads: lines joined by newlines, confidence weighted by length, 0..100. */
export function joinLines(lines: { text: string; confidence: number }[]): OcrResult {
  const kept = lines.filter((l) => l.text);
  const chars = kept.reduce((a, l) => a + l.text.length, 0);
  const conf = chars ? kept.reduce((a, l) => a + l.confidence * l.text.length, 0) / chars : 0;
  return { text: kept.map((l) => l.text).join("\n"), confidence: Math.round(conf * 1000) / 10 };
}

/**
 * At most this many lines are read from a block, the lowest: the collector info has two at the
 * bottom of its crop, and flavour text or the art can sit above.
 */
const MAX_BLOCK_LINES = 6;

export interface PaddleOcr extends OcrEngine {
  terminate(): Promise<void>;
}

export interface PaddleModels {
  /** The recogniser (PP-OCRv5 English mobile rec). */
  rec: Uint8Array;
  /** Its dictionary, one character per line. */
  dict: string;
  /** The text detector (PP-OCRv3 mobile det). Without it, crops are split into lines by rows. */
  det?: Uint8Array;
}

export async function createPaddleOcr(ort: OrtLike, models: PaddleModels, options: object = { executionProviders: ["wasm"], graphOptimizationLevel: "all" }): Promise<PaddleOcr> {
  const rec = await ort.InferenceSession.create(models.rec, options);
  const det = models.det ? await ort.InferenceSession.create(models.det, options) : null;
  const classes = classesFromDict(models.dict);
  const allowedFor = new Map<string, Uint8Array>();
  // One read at a time: a session isn't re-entrant, and the scanner asks for two at once.
  let queue: Promise<unknown> = Promise.resolve();

  const recognise = async (t: { data: Float32Array; width: number }, allowed?: Uint8Array) => {
    const out = await rec.run({ [rec.inputNames[0]!]: new ort.Tensor("float32", t.data, [1, 3, REC_HEIGHT, t.width]) });
    const o = out[rec.outputNames[0]!]!;
    if (o.dims[2] !== classes.length) throw new Error(`OCR model has ${o.dims[2]} classes, dictionary ${classes.length}`);
    return ctcDecode(o.data as Float32Array, o.dims[1]!, classes, allowed);
  };

  const detect = async (img: Gray): Promise<TextBox[][]> => {
    const t = detTensor(img);
    const out = await det!.run({ [det!.inputNames[0]!]: new ort.Tensor("float32", t.data, [1, 3, t.height, t.width]) });
    const prob = out[det!.outputNames[0]!]!.data as Float32Array;
    return groupLines(boxesFromMap(prob, t.width, t.height, img.width / t.width, img.height / t.height));
  };

  const read = async (img: Gray, opts: { mode: "line" | "block"; whitelist?: string }): Promise<OcrResult> => {
    let allowed: Uint8Array | undefined;
    if (opts.whitelist) {
      allowed = allowedFor.get(opts.whitelist);
      if (!allowed) allowedFor.set(opts.whitelist, (allowed = allowedClasses(classes, opts.whitelist)));
    }
    if (det) {
      const lines = await detect(img);
      if (lines.length) {
        // A line read: the line with the most text (the title, not a stray mark from the art or
        // frame). A block: every line, top to bottom.
        const size = (l: TextBox[]) => l.reduce((a, b) => a + b.halfW * b.halfH, 0);
        const chosen = opts.mode === "line" ? [lines.reduce((a, b) => (size(b) > size(a) ? b : a))] : lines.slice(-MAX_BLOCK_LINES);
        const out = [];
        for (const line of chosen) out.push(await recognise(boxTensor(img, mergeLine(line)), allowed));
        return joinLines(out);
      }
    }
    // No detector, or it found nothing (faint print): split the crop into lines by rows.
    const bands = findLines(img);
    if (bands.length === 0) return { text: "", confidence: 0 };
    if (opts.mode === "line") {
      // The line with the most ink: the title, not a stray edge of the art or frame.
      const main = bands.reduce((a, b) => (b.ink > a.ink ? b : a));
      return joinLines([await recognise(lineTensor(img, main.top, main.bottom), allowed)]);
    }
    const lines = [];
    for (const b of bands.slice(-MAX_BLOCK_LINES)) lines.push(await recognise(lineTensor(img, b.top, b.bottom), allowed));
    return joinLines(lines);
  };

  return {
    read(img, opts) {
      const next = queue.then(() => read(img, opts));
      queue = next.catch(() => undefined);
      return next;
    },
    async terminate() {
      await Promise.all([rec, det].map((s) => (s as { release?: () => Promise<void> } | null)?.release?.()));
    },
  };
}
