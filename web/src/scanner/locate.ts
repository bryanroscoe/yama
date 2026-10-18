// Snap the on-screen guide to the card's real edges. The user lines the card up with the guide,
// so each edge is somewhere near the matching guide side: look along the side's normal for a
// straight, consistent brightness step, fit a line, and intersect the four lines. No OpenCV.
// When an edge is unclear (black card on a black mat) that side keeps the guide's position.

import type { Gray, Point, Quad } from "./types";

interface Line {
  /** Unit normal and offset: n · p = c. */
  nx: number;
  ny: number;
  c: number;
}

const SAMPLES = 32;
/** How far either side of a guide side to look, as a share of the guide's width. */
const SEARCH = 0.09;
const STEPS = 48; // per half range

function sample(g: Gray, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix + 1 >= g.width || iy + 1 >= g.height) return -1;
  const fx = x - ix;
  const fy = y - iy;
  const i = iy * g.width + ix;
  const a = g.data[i]!;
  const b = g.data[i + 1]!;
  const c = g.data[i + g.width]!;
  const d = g.data[i + g.width + 1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function lineThrough(a: Point, b: Point): Line {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return { nx, ny, c: nx * a[0] + ny * a[1] };
}

function intersect(a: Line, b: Line): Point | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-6) return null;
  return [(a.c * b.ny - a.ny * b.c) / det, (a.nx * b.c - a.c * b.nx) / det];
}

/** Total-least-squares line through points. */
function fit(points: Point[]): Line {
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) {
    mx += x;
    my += y;
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the line
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return { nx, ny, c: nx * mx + ny * my };
}

/**
 * Find one card edge near the guide side a→b. `outward` is the unit normal pointing away from
 * the card. Returns null when no straight edge has enough support.
 */
function findEdge(g: Gray, a: Point, b: Point, outward: Point, range: number, cardWidth: number): Line | null {
  const step = range / STEPS;
  const tx = (b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ty = (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  // Candidates: (sample index, offset along the normal, strength).
  const cands: { i: number; d: number; s: number; p: Point }[] = [];
  const profile = new Float32Array(STEPS * 2 + 1);
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = 0.08 + (0.84 * i) / (SAMPLES - 1);
    const px = a[0] + (b[0] - a[0]) * t;
    const py = a[1] + (b[1] - a[1]) * t;
    let valid = true;
    for (let k = -STEPS; k <= STEPS; k += 1) {
      const d = k * step;
      let acc = 0;
      // Average a short run along the side to suppress noise and text.
      for (const w of [-2, -1, 0, 1, 2]) {
        const v = sample(g, px + outward[0] * d + tx * w * step, py + outward[1] * d + ty * w * step);
        if (v < 0) valid = false;
        acc += v;
      }
      profile[k + STEPS] = acc / 5;
    }
    if (!valid) continue;
    let max = 0;
    const grad = new Float32Array(profile.length);
    for (let k = 1; k < profile.length - 1; k += 1) {
      grad[k] = Math.abs(profile[k + 1]! - profile[k - 1]!);
      if (grad[k]! > max) max = grad[k]!;
    }
    if (max < 6) continue;
    const peaks: { k: number; s: number }[] = [];
    for (let k = 2; k < grad.length - 2; k += 1) {
      const s = grad[k]!;
      if (s >= 6 && s >= 0.12 * max && s >= grad[k - 1]! && s > grad[k + 1]!) peaks.push({ k, s });
    }
    peaks.sort((x, y) => y.s - x.s);
    for (const { k, s } of peaks.slice(0, 6)) {
      const d = (k - STEPS) * step;
      cands.push({ i, d, s, p: [px + outward[0] * d, py + outward[1] * d] });
    }
  }
  if (cands.length < 6) return null;

  // RANSAC over candidate pairs from different sample positions.
  const tol = step * 1.5;
  const guideLine = lineThrough(a, b);
  type Option = { line: Line; support: number; strength: number; outer: number; inliers: Point[] };
  let best: Option | null = null;
  const options: Option[] = [];
  for (let x = 0; x < cands.length; x += 1) {
    for (let y = x + 1; y < cands.length; y += 1) {
      const ca = cands[x]!;
      const cb = cands[y]!;
      if (Math.abs(ca.i - cb.i) < SAMPLES / 4) continue;
      const line = lineThrough(ca.p, cb.p);
      // Must be close to parallel with the guide side (within ~8 degrees).
      if (Math.abs(line.nx * guideLine.nx + line.ny * guideLine.ny) < 0.99) continue;
      const hit = new Map<number, { p: Point; s: number }>();
      for (const c of cands) {
        const dist = Math.abs(line.nx * c.p[0] + line.ny * c.p[1] - line.c);
        const prev = hit.get(c.i);
        if (dist <= tol && (!prev || prev.s < c.s)) hit.set(c.i, { p: c.p, s: c.s });
      }
      const support = hit.size;
      let strength = 0;
      for (const h of hit.values()) strength += h.s;
      const option = { line, support, strength: strength / Math.max(1, support), outer: (ca.d + cb.d) / 2, inliers: [...hit.values()].map((h) => h.p) };
      options.push(option);
      if (!best || support > best.support || (support === best.support && option.strength > best.strength)) best = option;
    }
  }
  if (!best || best.support < SAMPLES * 0.4) return null;
  // The card's outer edge and the frame line just inside it (the border, 2 to 6% of the card's
  // width) are parallel, and on a dark table the outer edge is the weaker one. Prefer a
  // clearly supported line a border's width further out.
  let chosen = best;
  for (const o of options) {
    const gap = o.outer - best.outer;
    if (o.support >= best.support * 0.6 && o.strength >= 8 && gap > step * 2 && gap < cardWidth * 0.065 && o.outer > chosen.outer) chosen = o;
  }
  return fit(chosen.inliers);
}

/** The guide quad snapped to the card's edges, or null when the edges are not clear enough. */
export function refineQuad(g: Gray, guide: Quad): Quad | null {
  const width = Math.hypot(guide[1][0] - guide[0][0], guide[1][1] - guide[0][1]);
  const range = width * SEARCH;
  const cx = (guide[0][0] + guide[1][0] + guide[2][0] + guide[3][0]) / 4;
  const cy = (guide[0][1] + guide[1][1] + guide[2][1] + guide[3][1]) / 4;
  const lines: Line[] = [];
  let found = 0;
  for (let s = 0; s < 4; s += 1) {
    const a = guide[s]!;
    const b = guide[(s + 1) % 4]!;
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let line = lineThrough(a, b);
    // Orient the normal away from the card's centre.
    let out: Point = [line.nx, line.ny];
    if ((mid[0] - cx) * out[0] + (mid[1] - cy) * out[1] < 0) out = [-out[0], -out[1]];
    const edge = findEdge(g, a, b, out, range, width);
    if (edge) {
      line = edge;
      found += 1;
    }
    lines.push(line);
  }
  if (found < 2) return null;
  const corners: Point[] = [];
  for (let s = 0; s < 4; s += 1) {
    const p = intersect(lines[(s + 3) % 4]!, lines[s]!);
    if (!p) return null;
    // A corner far from the guide means a wrong line.
    if (Math.hypot(p[0] - guide[s]![0], p[1] - guide[s]![1]) > width * 0.12) return null;
    corners.push(p);
  }
  const quad = corners as Quad;
  const w = (Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1])) / 2;
  const h = (Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1])) / 2;
  const aspect = h / w;
  if (aspect < (88 / 63) * 0.92 || aspect > (88 / 63) * 1.08) return null;
  // Opposite sides of a card seen at a slight angle are nearly the same length.
  const side = (i: number) => Math.hypot(quad[(i + 1) % 4]![0] - quad[i]![0], quad[(i + 1) % 4]![1] - quad[i]![1]);
  for (const [i, j] of [[0, 2], [1, 3]] as const) {
    const r = side(i) / side(j);
    if (r < 0.92 || r > 1.08) return null;
  }
  const area = w * h;
  const guideArea = width * Math.hypot(guide[3][0] - guide[0][0], guide[3][1] - guide[0][1]);
  if (area < guideArea * 0.8 || area > guideArea * 1.2) return null;
  return quad;
}
