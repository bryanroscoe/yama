// Small, dependency-free image helpers. Everything works on plain RGBA or grey buffers so the
// same code runs in the browser (ImageData) and in Node (decoded JPEGs in the eval harness).

import type { Gray, Point, Quad, RgbaImage } from "./types";

/** A rectangle in normalised card coordinates (0..1 across the card's width and height). */
export interface CardRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Real cards are 63 x 88 mm. */
export const CARD_ASPECT = 88 / 63;

/**
 * The 3x3 homography (row-major, h[8] = 1) taking the unit square's corners
 * (0,0) (1,0) (1,1) (0,1) to the quad's corners, so `apply(h, u, v)` maps normalised card
 * coordinates to image pixels. Closed form for square-to-quad (Heckbert 1989).
 */
export function squareToQuad(q: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function applyH(m: number[], u: number, v: number): Point {
  const w = m[6]! * u + m[7]! * v + 1;
  return [(m[0]! * u + m[1]! * v + m[2]!) / w, (m[3]! * u + m[4]! * v + m[5]!) / w];
}

/** Luma of an RGBA image (0..255, one byte per pixel). */
export function toGray(img: RgbaImage): Gray {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8;
  }
  return { width, height, data: out };
}

/**
 * Sample a region of the card (normalised coordinates) out of the image into an upright grey
 * image of outW x outH, bilinear. Sampling straight from the camera frame, rather than from a
 * pre-straightened card, keeps all the resolution the camera captured for small print.
 */
export function warpRegion(gray: Gray, quad: Quad, region: CardRegion, outW: number, outH: number): Gray {
  const m = squareToQuad(quad);
  const out = new Uint8ClampedArray(outW * outH);
  const { width, height, data } = gray;
  const du = (region.x1 - region.x0) / outW;
  const dv = (region.y1 - region.y0) / outH;
  for (let y = 0; y < outH; y += 1) {
    const v = region.y0 + (y + 0.5) * dv;
    for (let x = 0; x < outW; x += 1) {
      const u = region.x0 + (x + 0.5) * du;
      const w = m[6]! * u + m[7]! * v + 1;
      const sx = (m[0]! * u + m[1]! * v + m[2]!) / w - 0.5;
      const sy = (m[3]! * u + m[4]! * v + m[5]!) / w - 0.5;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const x0 = ix < 0 ? 0 : ix >= width ? width - 1 : ix;
      const x1 = ix + 1 < 0 ? 0 : ix + 1 >= width ? width - 1 : ix + 1;
      const y0 = iy < 0 ? 0 : iy >= height ? height - 1 : iy;
      const y1 = iy + 1 < 0 ? 0 : iy + 1 >= height ? height - 1 : iy + 1;
      const a = data[y0 * width + x0]!;
      const b = data[y0 * width + x1]!;
      const c = data[y1 * width + x0]!;
      const d = data[y1 * width + x1]!;
      out[y * outW + x] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** Same as `warpRegion` but keeps colour; used for the preview thumbnail and the embedder. */
export function warpRegionRgba(img: RgbaImage, quad: Quad, region: CardRegion, outW: number, outH: number): RgbaImage {
  const m = squareToQuad(quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const { width, height, data } = img;
  for (let y = 0; y < outH; y += 1) {
    const v = region.y0 + ((y + 0.5) / outH) * (region.y1 - region.y0);
    for (let x = 0; x < outW; x += 1) {
      const u = region.x0 + ((x + 0.5) / outW) * (region.x1 - region.x0);
      const [sx, sy] = applyH(m, u, v);
      const ix = Math.min(width - 1, Math.max(0, Math.round(sx - 0.5)));
      const iy = Math.min(height - 1, Math.max(0, Math.round(sy - 0.5)));
      const s = (iy * width + ix) * 4;
      const o = (y * outW + x) * 4;
      out[o] = data[s]!;
      out[o + 1] = data[s + 1]!;
      out[o + 2] = data[s + 2]!;
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** Otsu's threshold over a grey image. */
export function otsu(g: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < g.data.length; i += 1) hist[g.data[i]!]! += 1;
  const total = g.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Prepare a text crop for Tesseract: stretch contrast, make the text dark on light (the
 * collector line is white on black on most cards, black on white-bordered ones), and add a
 * white margin. Tesseract's own binarisation copes better with a clean grey image than with
 * our hard threshold, so we only normalise here.
 */
export function prepareText(g: Gray, pad = 12): Gray {
  const t = otsu(g);
  let dark = 0;
  for (let i = 0; i < g.data.length; i += 1) if (g.data[i]! <= t) dark += 1;
  const invert = dark > g.data.length / 2; // background is the majority class
  // Contrast stretch between the 2nd and 98th percentile.
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < g.data.length; i += 1) hist[g.data[i]!]! += 1;
  const lowCount = g.data.length * 0.02;
  const highCount = g.data.length * 0.98;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i += 1) {
    acc += hist[i]!;
    if (acc <= lowCount) lo = i;
    if (acc <= highCount) hi = i;
  }
  if (hi <= lo) hi = lo + 1;
  const w = g.width + pad * 2;
  const h = g.height + pad * 2;
  const out = new Uint8ClampedArray(w * h).fill(255);
  for (let y = 0; y < g.height; y += 1) {
    for (let x = 0; x < g.width; x += 1) {
      let v = ((g.data[y * g.width + x]! - lo) * 255) / (hi - lo);
      if (invert) v = 255 - v;
      out[(y + pad) * w + x + pad] = v;
    }
  }
  return { width: w, height: h, data: out };
}

/** Encode a grey image as an uncompressed 24-bit BMP, which Tesseract (Leptonica) reads. */
export function encodeBmp(g: Gray): Uint8Array {
  const rowSize = Math.ceil((g.width * 3) / 4) * 4;
  const size = 54 + rowSize * g.height;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, g.width, true);
  dv.setInt32(22, g.height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, rowSize * g.height, true);
  for (let y = 0; y < g.height; y += 1) {
    const row = 54 + (g.height - 1 - y) * rowSize;
    for (let x = 0; x < g.width; x += 1) {
      const v = g.data[y * g.width + x]!;
      buf[row + x * 3] = v;
      buf[row + x * 3 + 1] = v;
      buf[row + x * 3 + 2] = v;
    }
  }
  return buf;
}

/** The axis-aligned quad of a rectangle, in printed order. */
export function rectQuad(x: number, y: number, w: number, h: number): Quad {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/**
 * Crop a prepared text image (dark text on light) to its main band of text rows, found from the
 * number of light/dark transitions per row. Frame edges and art above or below a title are
 * long runs, not text, so they drop out. Returns the input when no band stands out.
 */
export function cropToTextBand(g: Gray, opts: { mergeGap?: number; pad?: number } = {}): Gray {
  const t = otsu(g);
  const rows = new Float32Array(g.height);
  for (let y = 0; y < g.height; y += 1) {
    let prev = g.data[y * g.width]! <= t;
    let n = 0;
    for (let x = 1; x < g.width; x += 1) {
      const cur = g.data[y * g.width + x]! <= t;
      if (cur !== prev) n += 1;
      prev = cur;
    }
    rows[y] = n;
  }
  const smooth = new Float32Array(g.height);
  let max = 0;
  for (let y = 0; y < g.height; y += 1) {
    smooth[y] = ((rows[y - 1] ?? rows[y]!) + rows[y]! + (rows[y + 1] ?? rows[y]!)) / 3;
    max = Math.max(max, smooth[y]!);
  }
  if (max < 6) return g;
  // Bands of text-like rows; merge bands separated by small gaps (two-line blocks).
  const bands: [number, number][] = [];
  for (let y = 0; y < g.height; y += 1) {
    if (smooth[y]! < max * 0.3) continue;
    const lastBand = bands[bands.length - 1];
    const gap = opts.mergeGap ?? 0;
    if (lastBand && y - lastBand[1] <= gap + 1) lastBand[1] = y;
    else bands.push([y, y]);
  }
  // Keep the band with the most transitions.
  let best: [number, number] | null = null;
  let bestScore = 0;
  for (const b of bands) {
    let s = 0;
    for (let y = b[0]; y <= b[1]; y += 1) s += smooth[y]!;
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }
  if (!best || best[1] - best[0] < 4) return g;
  const h = best[1] - best[0] + 1;
  const pad = Math.round(h * (opts.pad ?? 0.35));
  const y0 = Math.max(0, best[0] - pad);
  const y1 = Math.min(g.height - 1, best[1] + pad);
  const out = new Uint8ClampedArray(g.width * (y1 - y0 + 1));
  out.set(g.data.subarray(y0 * g.width, (y1 + 1) * g.width));
  return { width: g.width, height: y1 - y0 + 1, data: out };
}
