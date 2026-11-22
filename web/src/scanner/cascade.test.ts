import { describe, expect, it } from "vitest";
import { createRecognizer, parseArts, type OrtLike } from "./recognizer";
import type { RgbaImage } from "./types";

// The embed cascade (recognizer.ts, FIRST_STAGE): an art model that takes `cuts` embeds the modern and
// old cuts first, and the other cuts only when that doesn't settle the frame.

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const field = (f: number, bytes: number[]) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
const num = (f: number, v: number) => [...varint(f * 8), ...varint(v)];
const tensor = (name: string, dims: number[], dataType: number, raw: Uint8Array) => [
  ...dims.flatMap((d) => num(1, d)),
  ...num(2, dataType),
  ...field(8, [...new TextEncoder().encode(name)]),
  ...field(9, [...raw]),
];
function floatToHalf(v: number): number {
  const i = new Uint32Array(new Float32Array([v]).buffer)[0]!;
  const e = ((i >>> 23) & 0xff) - 127 + 15;
  return e <= 0 ? (i >>> 16) & 0x8000 : ((i >>> 16) & 0x8000) | (e << 10) | ((i >>> 13) & 0x3ff);
}

const D = 4;
/** Three frame cuts, so the first stage is cuts 0 and 1 and the second cut 2. */
const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63, frame_names: ["modern", "old", "extended"] };
// A search graph the set lock can read: Sol Ring (modern), Island (old), Forest (extended).
const searchGraph = new Uint8Array(
  field(7, [
    ...field(5, tensor("gallery", [3, D], 10, new Uint8Array(new Uint16Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].map(floatToHalf)).buffer))),
    ...field(5, tensor("frames", [3, 1], 7, new Uint8Array(new BigInt64Array([0n, 1n, 2n]).buffer))),
    ...field(5, tensor("penalties", [3], 1, new Uint8Array(new Float32Array([0, 0, 0]).buffer))),
  ]),
);
const arts = parseArts([
  { id: "a", name: "Sol Ring", set: "ecc", collector_number: "57", illustration_id: "ill-a" },
  { id: "b", name: "Island", set: "fdn", collector_number: "272", illustration_id: "ill-b" },
  { id: "c", name: "Forest", set: "fdn", collector_number: "281", illustration_id: "ill-c" },
]);

class Tensor {
  constructor(
    readonly type: string,
    readonly data: Uint8Array | Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

type Top = [number, number][];

/**
 * A stand-in ONNX Runtime: a card in the middle of the frame; the embed graph fills only the rows of
 * the cuts it's given; the search answers `first` while cut 2's row is empty, `all` once it isn't.
 */
function fakeOrt(first: Top, all: Top, takesCuts = true) {
  const cutsFed: (number[] | null)[] = [];
  const searched: Float32Array[] = [];
  const ort: OrtLike = {
    Tensor: Tensor as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create(model) {
        const kind = model.length > 1 ? 3 : model[0];
        return {
          inputNames: kind === 2 ? (takesCuts ? ["scene", "quad", "cuts"] : ["scene", "quad"]) : kind === 3 ? ["embeddings"] : ["window"],
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
              const cuts = feeds.cuts ? Array.from((feeds.cuts as Tensor).data as BigInt64Array, Number) : null;
              cutsFed.push(cuts);
              const e = new Float32Array(3 * D);
              for (const c of cuts ?? [0, 1, 2]) e[c * D + c] = 1;
              return { embeddings: new Tensor("float32", e, [3, D]) };
            }
            const e = (feeds.embeddings as Tensor).data as Float32Array;
            searched.push(Float32Array.from(e));
            const top = e[2 * D + 2] ? all : first;
            return { indices: { data: BigInt64Array.from(top.map(([i]) => BigInt(i))) }, scores: { data: Float32Array.from(top.map(([, s]) => s)) } };
          },
        };
      },
    },
  };
  return { ort, cutsFed, searched };
}

const graphs = { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: searchGraph };

/** A 640 px frame with print on it (a checkerboard), so the found card isn't a blank surface. */
function frame(): RgbaImage {
  const data = new Uint8ClampedArray(640 * 640 * 4);
  for (let y = 0; y < 640; y += 1)
    for (let x = 0; x < 640; x += 1) {
      const v = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 230 : 20;
      data.set([v, v, v, 255], (y * 640 + x) * 4);
    }
  return { width: 640, height: 640, data };
}

async function scan(first: Top, all: Top, opts: { takesCuts?: boolean; pool?: number[] } = {}) {
  const fake = fakeOrt(first, all, opts.takesCuts ?? true);
  const recognizer = await createRecognizer(fake.ort, graphs, constants, arts);
  if (opts.pool) recognizer.setPool(opts.pool);
  fake.cutsFed.length = 0;
  fake.searched.length = 0;
  const r = await recognizer.identify(frame());
  return { r, ...fake };
}

describe("the embed cascade", () => {
  it("embeds the modern and old cuts first and stops there when a card leads", async () => {
    const { r, cutsFed } = await scan([[0, 0.9], [1, 0.5]], [[2, 0.95]]);
    expect(cutsFed).toEqual([[0, 1]]);
    expect(r.matches.map((m) => m.name)).toEqual(["Sol Ring", "Island"]);
    expect(r.timings.cuts).toBe(2);
  });

  it("embeds the other cuts when the first stage doesn't lead, and searches every cut together", async () => {
    const { r, cutsFed, searched } = await scan([[0, 0.7], [1, 0.65]], [[2, 0.95], [0, 0.7]]);
    expect(cutsFed).toEqual([[0, 1], [2]]);
    // The second search sees both stages' rows: the whole embedding.
    expect(Array.from(searched[1]!)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(r.matches.map((m) => m.name)).toEqual(["Forest", "Sol Ring"]);
    expect(r.timings.cuts).toBe(3);
  });

  it("asks the first stage for more than the lead rule's 0.65", async () => {
    // Leads by 0.16, but at 0.66: the other cuts are embedded too.
    const { cutsFed } = await scan([[0, 0.66], [1, 0.5]], [[0, 0.66], [1, 0.5]]);
    expect(cutsFed).toEqual([[0, 1], [2]]);
  });

  it("reads every cut when the first stage leads at under 0.70 (22 Nov 2026: 3 of 42 such were the wrong card)", async () => {
    const { cutsFed } = await scan([[0, 0.69], [1, 0.5]], [[0, 0.69], [1, 0.5]]);
    expect(cutsFed).toEqual([[0, 1], [2]]);
    const settled = await scan([[0, 0.71], [1, 0.5]], [[0, 0.71], [1, 0.5]]);
    expect(settled.cutsFed).toEqual([[0, 1]]);
  });

  it("embeds every cut at once with the set lock on", async () => {
    const { r, cutsFed } = await scan([[0, 0.9], [1, 0.5]], [[0, 0.9], [1, 0.5]], { pool: [2] });
    expect(cutsFed).toEqual([[0, 1, 2]]);
    expect(r.pool?.map((m) => m.name)).toEqual(["Forest"]);
  });

  it("runs an art model without `cuts` as before, every cut at once", async () => {
    const { r, cutsFed } = await scan([[0, 0.9], [1, 0.5]], [[0, 0.9], [1, 0.5]], { takesCuts: false });
    expect(cutsFed).toEqual([null]);
    expect(r.timings.cuts).toBe(3);
  });

  it("times each graph run by graph, for the speed test: passes, the stages' embeddings and searches", async () => {
    const fake = fakeOrt([[0, 0.7], [1, 0.65]], [[2, 0.95], [0, 0.7]]);
    const recognizer = await createRecognizer(fake.ort, graphs, constants, arts);
    // A new card: a pass over the middle, then one around the card; both stages and their searches.
    const fresh = await recognizer.identify(frame());
    expect(fresh.timings.runs?.detector).toHaveLength(2);
    expect(fresh.timings.runs?.embed).toHaveLength(2);
    expect(fresh.timings.runs?.search).toHaveLength(2);
    expect([...fresh.timings.runs!.detector, ...fresh.timings.runs!.embed, ...fresh.timings.runs!.search].every((ms) => ms >= 0)).toBe(true);
    // The same card again: tracked, one pass. A model switch warming up never counts in a frame's runs.
    await recognizer.setEmbed(Uint8Array.of(2));
    await recognizer.setDetector(Uint8Array.of(1));
    const tracked = await recognizer.identify(frame());
    const again = await recognizer.identify(frame());
    expect(tracked.timings.runs?.detector).toHaveLength(2);
    expect(again.timings.runs?.detector).toHaveLength(1);
    expect(again.timings.runs?.embed).toHaveLength(2);
  });
});
