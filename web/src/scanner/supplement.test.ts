import { describe, expect, it } from "vitest";
import { galleryOf } from "./gallery";
import { createRecognizer, parseArts, parseSupplement, poolIndices, type OrtLike } from "./recognizer";
import type { RgbaImage } from "./types";

// The server's artwork supplement (server/src/scan_art.rs) scored next to the search graph's rows.

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
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const D = 4;
// The bundle: three artworks. Row 1 is frame 1 (whose cut embeds to zeros below).
const bundleRows = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
];
const searchGraph = new Uint8Array(
  field(7, [
    ...field(5, tensor("gallery", [3, D], 10, new Uint8Array(new Uint16Array(bundleRows.flat().map(floatToHalf)).buffer))),
    ...field(5, tensor("frames", [3, 1], 7, new Uint8Array(new BigInt64Array([0n, 1n, 0n]).buffer))),
    ...field(5, tensor("penalties", [3], 1, new Uint8Array(new Float32Array([0, 0, 0]).buffer))),
  ]),
);
const arts = parseArts([
  { id: "a", name: "Sol Ring", set: "ecc", collector_number: "57", illustration_id: "ill-a" },
  { id: "b", name: "Island", set: "fdn", collector_number: "272", illustration_id: "ill-b" },
  { id: "c", name: "Forest", set: "fdn", collector_number: "281", illustration_id: "ill-c" },
]);

/** What the server serves: Tricorder matches the frame-0 cut (less the rare-frame penalty here), Gorn doesn't. */
const supplementJson = (bundle = "v1") => ({
  bundle,
  dim: D,
  columns: ["id", "name", "set", "number", "illustration_id", "layout", "printings"],
  rows: [
    ["t1", "Tricorder", "trk", "270", "ill-t", "normal", 2],
    ["t2", "Gorn Captain", "trc", "172", "ill-g", "normal", 1],
  ],
  frames: [0, 0],
  penalties: [0.02, 0],
  vectors: base64(new Uint8Array(new Uint16Array([1, 0, 0, 0, 0, 0, 0, 1].map(floatToHalf)).buffer)),
});

class Tensor {
  constructor(
    readonly type: string,
    readonly data: Uint8Array | Float32Array,
    readonly dims: readonly number[],
  ) {}
}

/** A stand-in ONNX Runtime: a card in the middle of the frame, whose frame-0 cut embeds to [1, 0, 0, 0]. */
function fakeOrt() {
  const fed: Record<string, unknown>[] = [];
  const ort: OrtLike = {
    Tensor: Tensor as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create(model) {
        const kind = model.length > 1 ? 3 : model[0];
        if (kind === 5) throw new Error("not a graph");
        return {
          inputNames: kind === 3 ? ["embeddings", "mask"] : ["x"],
          async run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> {
            if (kind === 1) {
              return {
                quad: { data: Float32Array.from([68, 44, 188, 44, 188, 212, 68, 212]) },
                up: { data: Float32Array.from([4, 0]) },
                centre: { data: Float32Array.from([128, 128]) },
                short: { data: Float32Array.from([120]) },
              };
            }
            // Embed graphs: 2 (the bundle's) puts the frame-0 cut at [1, 0, 0, 0]; 4 (another
            // art model) at [0, 0, 0, 1].
            if (kind === 2 || kind === 4) {
              const e = new Float32Array(17 * D);
              e[kind === 2 ? 0 : 3] = 1;
              return { embeddings: { data: e } };
            }
            fed.push(feeds);
            // The graph's top: bundle row 0 at 0.9, row 2 at 0.4 (or -3 when masked out).
            const mask = (feeds.mask as Tensor | undefined)?.data;
            return mask?.[0] === 0
              ? { indices: { data: BigInt64Array.from([2n, 0n]) }, scores: { data: Float32Array.from([0.4, -3]) } }
              : { indices: { data: BigInt64Array.from([0n, 2n]) }, scores: { data: Float32Array.from([0.9, 0.4]) } };
          },
        };
      },
    },
  };
  return { ort, fed };
}

const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };
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

describe("the artwork supplement", () => {
  it("parses the server's file and refuses one for another bundle or that doesn't add up", () => {
    const s = parseSupplement(supplementJson(), "v1");
    expect(s.arts.map((a) => [a.name, a.set, a.number, a.illustrationId, a.printings])).toEqual([
      ["Tricorder", "trk", "270", "ill-t", 2],
      ["Gorn Captain", "trc", "172", "ill-g", 1],
    ]);
    expect([s.gallery.count, s.gallery.dim]).toEqual([2, D]);
    expect(() => parseSupplement(supplementJson("v0"), "v1")).toThrow(/bundle v0/);
    expect(() => parseSupplement({ ...supplementJson(), frames: [0] }, "v1")).toThrow();
    expect(() => parseSupplement({ rows: [] }, "v1")).toThrow();
  });

  it("scores rows as the search graph does: dot product with its frame's cut, less its penalty", () => {
    const g = galleryOf(new Uint16Array([1, 0, 0, 1].map(floatToHalf)), Int32Array.from([0, 1]), Float32Array.from([0.02, 0.1]), 2);
    const emb = Float32Array.from([0.6, 0.8, 0, 1]);
    const top = g.search(emb, [0, 1], 2);
    expect(top[0]!.index).toBe(1);
    expect(top[0]!.score).toBeCloseTo(0.9, 3);
    expect(top[1]!.score).toBeCloseTo(0.58, 3);
  });

  it("merges its rows into the top matches by score, numbered after the bundle's", async () => {
    const { ort } = fakeOrt();
    const recognizer = await createRecognizer(ort, graphs, constants, arts, parseSupplement(supplementJson(), "v1"));
    const r = await recognizer.identify(frame());
    expect(r.quad).not.toBeNull();
    expect(r.matches.map((m) => [m.name, m.index])).toEqual([
      ["Tricorder", 3],
      ["Sol Ring", 0],
    ]);
    expect(r.matches[0]!.score).toBeCloseTo(0.98, 3);
    expect(r.matches[1]!.score).toBeCloseTo(0.9, 3);
  });

  it("leaves the matches alone without one", async () => {
    const { ort } = fakeOrt();
    const recognizer = await createRecognizer(ort, graphs, constants, arts);
    const r = await recognizer.identify(frame());
    expect(r.matches.map((m) => m.name)).toEqual(["Sol Ring", "Forest"]);
  });

  it("locks to a set whose artworks only the supplement knows", async () => {
    const { ort } = fakeOrt();
    const supplement = parseSupplement(supplementJson(), "v1");
    const recognizer = await createRecognizer(ort, graphs, constants, arts, supplement);
    // The worker's pool indices run over the bundle's arts, then the supplement's.
    const indices = poolIndices(arts.concat(supplement.arts), { illustrations: ["ill-t", "ill-g", "ill-b"], ids: [] });
    expect(indices).toEqual([1, 3, 4]);
    expect(recognizer.setPool(indices)).toBe(true);
    const r = await recognizer.identify(frame());
    expect(r.pool!.map((m) => [m.name, m.index])).toEqual([
      ["Tricorder", 3],
      ["Island", 1],
      ["Gorn Captain", 4],
    ]);
    expect(r.pool![0]!.score).toBeCloseTo(r.matches[0]!.score, 6);
  });

  it("hides bundle rows from the graph and the pool, for evals", async () => {
    const { ort, fed } = fakeOrt();
    const recognizer = await createRecognizer(ort, graphs, constants, arts, parseSupplement(supplementJson(), "v1"), { hidden: [0] });
    expect(Array.from((fed[0]!.mask as Tensor).data)).toEqual([0, 1, 1]);
    recognizer.setPool([0, 2]);
    const r = await recognizer.identify(frame());
    expect(r.matches.map((m) => m.name)).toEqual(["Tricorder", "Forest"]);
    expect(r.pool!.map((m) => m.name)).toEqual(["Forest"]);
  });

  it("runs another art model once it's loaded, keeping the rest, and keeps the one before if it fails", async () => {
    const { ort } = fakeOrt();
    const recognizer = await createRecognizer(ort, graphs, constants, arts, parseSupplement(supplementJson(), "v1"));
    const best = async () => (await recognizer.identify(frame())).matches.find((m) => m.set === "trk" || m.set === "trc")?.name;
    expect(await best()).toBe("Tricorder");
    // The other model embeds the card where Gorn Captain's vector is.
    await recognizer.setEmbed(Uint8Array.of(4));
    expect(await best()).toBe("Gorn Captain");
    await expect(recognizer.setEmbed(Uint8Array.of(5))).rejects.toThrow("not a graph");
    expect(await best()).toBe("Gorn Captain");
    await recognizer.setEmbed(Uint8Array.of(2));
    expect(await best()).toBe("Tricorder");
  });
});
