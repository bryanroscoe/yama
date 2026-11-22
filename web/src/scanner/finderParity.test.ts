/// <reference types="node" />
// The card finder's window logic, the web's (recognizer.ts) against the Android app's port
// (web/android/.../CardFinder.java), on the same frames with the same made-up detector. This test
// runs the web side and checks it against the fixture the Java test reads
// (web/android/app/src/test/resources/finder-parity.json, CardFinderTest): every window the
// detector was shown (a hash of its bytes), and the corners, vote and verdict of each frame. A change
// to either side's windows or thresholds fails one of the two tests until both agree again.
//
// The frames and the detector are defined in whole numbers only, so Java makes exactly the same
// ones. To write the fixture again after an intended change to recognizer.ts (and the same change
// to CardFinder.java):
//
//   UPDATE_FINDER_PARITY=1 npx vitest run web/src/scanner/finderParity.test.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecognizer, type OrtLike } from "./recognizer";
import type { RgbaImage } from "./types";

const FIXTURE = join(__dirname, "../../android/app/src/test/resources/finder-parity.json");
const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };
const W = 640;
const H = 1138;

/** A card on the frame: its box [x0, y0, x1, y1) and whether it's printed (a flat one has no detail). */
interface Card {
  box: [number, number, number, number];
  flat?: boolean;
}

/** The frames, in order: a card held and drifting, gone, back elsewhere, too close, too small, blank. */
export const FRAMES: (Card | null)[] = [
  ...Array.from({ length: 11 }, (_, i): Card => ({ box: [200 + i * 3, 300 + i * 2, 440 + i * 3, 636 + i * 2] })),
  null,
  { box: [20, 20, 200, 270] },
  { box: [10, 100, 630, 968] },
  { box: [300, 500, 340, 556] },
  { box: [180, 380, 420, 716], flat: true },
  { box: [250, 420, 470, 728] },
  { box: [252, 421, 472, 729] },
];

/** CardFinderTest.frame: the same pixels. */
export function frame(card: Card | null): RgbaImage {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const inside = !!card && x >= card.box[0] && x < card.box[2] && y >= card.box[1] && y < card.box[3];
      if (inside && card!.flat) {
        data[o] = 200;
        data[o + 1] = 120;
        data[o + 2] = 60;
      } else if (inside) {
        data[o] = 150 + ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 90;
        data[o + 1] = 60 + ((x * 7 + y * 3) % 50);
        data[o + 2] = 30 + ((x + y * 11) % 40);
      } else {
        data[o] = (x * 3 + y * 5) % 97;
        data[o + 1] = ((x * 5) ^ (y * 7)) % 101;
        data[o + 2] = 70;
      }
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** FNV-1a over the window's bytes. */
function fnv(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * CardFinderTest.FakeDetector: the bright pixels' box is the card, the share of it they fill its
 * vote (times four views); a window with fewer than 64 votes for nothing. Outputs are float32, as
 * ONNX Runtime's are.
 */
export function fakeDetect(window: Uint8Array, size = 256) {
  let count = 0;
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (window[(y * size + x) * 4]! < 150) continue;
      count++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  const f = (v: number[]) => Float32Array.from(v);
  if (count < 64) return { quad: f([0, 0, size, 0, size, size, 0, size]), up: f([0, 0.4]), centre: f([size / 2, size / 2]), short: f([size]) };
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  return {
    quad: f([x0, y0, x1 + 1, y0, x1 + 1, y1 + 1, x0, y1 + 1]),
    up: f([0, (4 * count) / (bw * bh)]),
    centre: f([(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2]),
    short: f([Math.min(bw, bh)]),
  };
}

class Tensor {
  constructor(
    readonly type: string,
    readonly data: Uint8Array | Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

interface Seen {
  windows: number[];
  inView: boolean;
  quad?: number[];
  vote: number;
}

async function runWeb(): Promise<Seen[]> {
  let windows: number[] = [];
  const ort: OrtLike = {
    Tensor: Tensor as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create(model) {
        const kind = model[0];
        return {
          inputNames: kind === 1 ? ["window"] : kind === 2 ? ["scene", "quad"] : ["embeddings"],
          async run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> {
            if (kind === 1) {
              const w = (feeds.window as Tensor).data as Uint8Array;
              windows.push(fnv(w));
              const d = fakeDetect(w);
              return { quad: { data: d.quad }, up: { data: d.up }, centre: { data: d.centre }, short: { data: d.short } };
            }
            if (kind === 2) return { embeddings: new Tensor("float32", new Float32Array(4), [1, 4]) };
            return { indices: { data: BigInt64Array.from([]) }, scores: { data: Float32Array.from([]) } };
          },
        };
      },
    },
  };
  const r = await createRecognizer(ort, { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: Uint8Array.of(3) }, constants, []);
  r.reset();
  const out: Seen[] = [];
  for (const card of FRAMES) {
    windows = [];
    const l = await r.locate(frame(card));
    out.push({ windows, inView: !!l.quad, ...(l.quad ? { quad: l.quad.flat() } : {}), vote: l.upright });
  }
  return out;
}

// The search graph here can't be read for the set lock, which the recognizer only warns about.
beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => undefined));

describe("the card finder's windows, web and app", () => {
  it("match the fixture the app's port is tested against", async () => {
    const seen = await runWeb();
    // The sequence covers what it's for: tracking, retracking, a fresh search, the whole-frame pass, and each refusal.
    expect(seen.filter((s) => s.windows.length === 1).length).toBeGreaterThanOrEqual(8);
    expect(seen.some((s) => s.windows.length === 3)).toBe(true);
    expect(seen.filter((s) => !s.inView).length).toBeGreaterThanOrEqual(3);
    const fixture = { constants, width: W, height: H, frames: FRAMES, seen };
    if (process.env.UPDATE_FINDER_PARITY) writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fixture)));
  }, 60_000);
});
