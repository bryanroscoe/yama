// The embed graph is given only the card's box of the frame (cardWindow): the card it warps out must
// come out the same as from the whole frame.

import { describe, expect, it } from "vitest";
import { cardWindow, convex, createRecognizer, parseArts, type OrtLike } from "./recognizer";
import type { Quad, RgbaImage } from "./types";

function noise(w: number, h: number, seed = 11): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) data[i] = (s = (s * 1103515245 + 12345) % 2147483648) % 256;
  return { width: w, height: h, data };
}

/** Bilinear sample of channel `ch` at (x, y), zero past the edges: the embed graph's GridSample (align_corners, zeros). */
function sample(img: RgbaImage, x: number, y: number, ch: number): number {
  const at = (px: number, py: number) => (px < 0 || py < 0 || px >= img.width || py >= img.height ? 0 : img.data[(py * img.width + px) * 4 + ch]!);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/** Points across the quad, edges included, as the warp samples it. */
function across(q: Quad): [number, number][] {
  const out: [number, number][] = [];
  for (let j = 0; j <= 20; j++) {
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      const v = j / 20;
      const [a, b, c, d] = q;
      out.push([(1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]), (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1])]);
    }
  }
  return out;
}

describe("cardWindow", () => {
  const frame = noise(640, 1138);

  it("samples the card exactly as the whole frame does, from a third of the pixels", () => {
    const quad: Quad = [[143.6, 301.2], [497.9, 288.4], [512.3, 790.8], [131.1, 805.5]];
    const w = cardWindow(frame, quad);
    expect(w.frame.width * w.frame.height).toBeLessThan(0.4 * frame.width * frame.height);
    for (const [[x, y], [cx, cy]] of across(quad).map((p, i) => [p, across(w.quad)[i]!] as const)) {
      for (let ch = 0; ch < 3; ch++) expect(sample(w.frame, cx, cy, ch)).toBeCloseTo(sample(frame, x, y, ch), 6);
    }
  });

  it("stops at the frame's edge, so a card partly out of view pads the same way", () => {
    const quad: Quad = [[-40.5, -12], [300, -30.2], [320.4, 420], [-55, 440.7]];
    const w = cardWindow(frame, quad);
    expect(w.quad[0]).toEqual([-40.5, -12]);
    for (const [[x, y], [cx, cy]] of across(quad).map((p, i) => [p, across(w.quad)[i]!] as const)) {
      expect(sample(w.frame, cx, cy, 1)).toBeCloseTo(sample(frame, x, y, 1), 6);
    }
  });

  it("stops at the right and bottom edges too", () => {
    const quad: Quad = [[420.2, 800.6], [690.4, 790], [700.9, 1180.3], [410, 1200.5]];
    const w = cardWindow(frame, quad);
    expect([w.frame.width, w.frame.height]).toEqual([640 - 408, 1138 - 788]);
    for (const [[x, y], [cx, cy]] of across(quad).map((p, i) => [p, across(w.quad)[i]!] as const)) {
      expect(sample(w.frame, cx, cy, 2)).toBeCloseTo(sample(frame, x, y, 2), 6);
    }
  });

  it("keeps the frame for a quad folded over itself, whose warp reads outside its corners' box", () => {
    const dragged: Quad = [[150, 300], [500, 300], [260, 420], [140, 800]];
    const bowtie: Quad = [[150, 300], [500, 800], [500, 300], [150, 800]];
    expect(convex(dragged)).toBe(false);
    expect(convex(bowtie)).toBe(false);
    expect(cardWindow(frame, dragged).frame).toBe(frame);
    expect(cardWindow(frame, bowtie).frame).toBe(frame);
    expect(convex([[150, 300], [500, 300], [500, 800], [150, 800]])).toBe(true);
    expect(convex([[150, 800], [500, 800], [500, 300], [150, 300]])).toBe(true);
  });

  it("keeps the frame when the box would be all of it, or the quad isn't a place", () => {
    const all: Quad = [[0, 0], [640, 0], [640, 1138], [0, 1138]];
    expect(cardWindow(frame, all).frame).toBe(frame);
    const lost: Quad = [[NaN, 0], [10, 0], [10, 10], [0, 10]];
    expect(cardWindow(frame, lost).frame).toBe(frame);
    const off: Quad = [[-500, -500], [-400, -500], [-400, -300], [-500, -300]];
    expect(cardWindow(frame, off).frame).toBe(frame);
  });
});

describe("the recognizer's art match", () => {
  it("gives the embed graph the card's box and the quad within it", async () => {
    const fed: { dims: readonly number[]; quad: number[] }[] = [];
    class Tensor {
      constructor(
        readonly type: string,
        readonly data: Uint8Array | Float32Array,
        readonly dims: readonly number[],
      ) {}
    }
    const ort: OrtLike = {
      Tensor: Tensor as unknown as OrtLike["Tensor"],
      InferenceSession: {
        async create(model) {
          const kind = model[0];
          return {
            inputNames: kind === 3 ? ["embeddings"] : ["x"],
            async run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> {
              if (kind === 1) {
                return {
                  quad: { data: Float32Array.from([68, 44, 188, 44, 188, 212, 68, 212]) },
                  up: { data: Float32Array.from([4, 0]) },
                  centre: { data: Float32Array.from([128, 128]) },
                  short: { data: Float32Array.from([120]) },
                };
              }
              if (kind === 2) {
                fed.push({ dims: (feeds.scene as Tensor).dims, quad: Array.from((feeds.quad as Tensor).data) });
                return { embeddings: { data: new Float32Array(17 * 4) } };
              }
              return { indices: { data: BigInt64Array.from([0n]) }, scores: { data: Float32Array.from([0.9]) } };
            },
          };
        },
      },
    };
    const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };
    const arts = parseArts([{ id: "a", name: "Sol Ring", set: "ecc", collector_number: "57", illustration_id: "ill-a" }]);
    const recognizer = await createRecognizer(ort, { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: Uint8Array.of(3) }, constants, arts);
    fed.length = 0;
    const checker = noise(640, 1138);
    const r = await recognizer.identify(checker);
    expect(r.quad).not.toBeNull();
    const q = r.quad!;
    const x0 = Math.floor(Math.min(...q.map((p) => p[0]))) - 2;
    const y0 = Math.floor(Math.min(...q.map((p) => p[1]))) - 2;
    const last = fed[fed.length - 1]!;
    expect(last.dims[0]).toBeLessThan(1138);
    expect(last.dims[1]).toBeLessThan(640);
    q.flat().forEach((v, i) => expect(last.quad[i]).toBeCloseTo(v - (i % 2 ? y0 : x0), 4));
  });
});
