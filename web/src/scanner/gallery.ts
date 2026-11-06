// The artwork gallery inside the bundle's search graph, for searching part of it: the set lock
// (only the arts of the sets being scanned) and anything else that needs more than the graph's
// top 5 across every artwork.
//
// The search graph (search.onnx) is small and fixed: for each artwork i,
//   score_i = gallery_i · embeddings[frames_i] − penalties_i
// where `embeddings` holds one vector per frame type (the embed graph's output), `frames_i` is
// the frame artwork i is printed in, and `penalties` are the bundle's frame and hub penalties;
// then the top 5. Reading its three tensors lets us do the same over any subset, in plain
// JavaScript, with the same scores the graph gives (checked in setlock.test.ts, and against the
// pinned bundle's graph: docs/scanner.md).

export interface Gallery {
  /** Artworks in the gallery. */
  count: number;
  /** Numbers per vector. */
  dim: number;
  /** Score these artworks (gallery indices) against an embed output, best first, at most `k`. */
  search(embeddings: Float32Array, indices: Iterable<number>, k: number): { index: number; score: number }[];
}

interface Tensor {
  dims: number[];
  dataType: number;
  raw: Uint8Array;
}

// ONNX TensorProto data types used here.
const FLOAT = 1;
const INT64 = 7;
const FLOAT16 = 10;

/** A minimal protobuf reader: (field, wire type, value) for each field in a message. */
function* fields(b: Uint8Array, start = 0, end = b.length): Generator<[number, number, number | [number, number]]> {
  let p = start;
  const varint = () => {
    let r = 0;
    let mul = 1;
    for (;;) {
      const x = b[p++]!;
      r += (x & 127) * mul;
      if (!(x & 128)) return r;
      mul *= 128;
    }
  };
  while (p < end) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) yield [field, wire, varint()];
    else if (wire === 2) {
      const n = varint();
      yield [field, wire, [p, p + n]];
      p += n;
    } else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else throw new Error(`The search graph isn't in a form the scanner reads (wire type ${wire})`);
  }
}

/** A packed repeated varint field. */
function packedVarints(b: Uint8Array, start: number, end: number): number[] {
  const out: number[] = [];
  let p = start;
  while (p < end) {
    let r = 0;
    let mul = 1;
    for (;;) {
      const x = b[p++]!;
      r += (x & 127) * mul;
      if (!(x & 128)) break;
      mul *= 128;
    }
    out.push(r);
  }
  return out;
}

/** The graph's initializers by name (ModelProto.graph = 7, GraphProto.initializer = 5). */
function initializers(model: Uint8Array): Map<string, Tensor> {
  const out = new Map<string, Tensor>();
  const text = new TextDecoder();
  for (const [f, w, v] of fields(model)) {
    if (f !== 7 || w !== 2) continue;
    const [gs, ge] = v as [number, number];
    for (const [g, gw, gv] of fields(model, gs, ge)) {
      if (g !== 5 || gw !== 2) continue;
      const [ts, te] = gv as [number, number];
      const t: Tensor & { name: string } = { name: "", dims: [], dataType: 0, raw: new Uint8Array(0) };
      for (const [tf, tw, tv] of fields(model, ts, te)) {
        if (tf === 1) {
          if (tw === 0) t.dims.push(tv as number);
          else t.dims.push(...packedVarints(model, ...(tv as [number, number])));
        } else if (tf === 2) t.dataType = tv as number;
        else if (tf === 8) t.name = text.decode(model.subarray(...(tv as [number, number])));
        else if (tf === 9) t.raw = model.subarray(...(tv as [number, number]));
      }
      out.set(t.name, t);
    }
  }
  return out;
}

/** IEEE half precision to a number. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

const HALF = (() => {
  const t = new Float32Array(65536);
  for (let i = 0; i < 65536; i += 1) t[i] = halfToFloat(i);
  return t;
})();

/** Copy a tensor's bytes into an aligned buffer. */
const aligned = (raw: Uint8Array) => raw.slice().buffer;

/** Read the gallery out of the search graph's bytes. Throws when the graph isn't the expected shape. */
export function readGallery(searchGraph: Uint8Array): Gallery {
  const t = initializers(searchGraph);
  const gallery = t.get("gallery");
  const frames = t.get("frames");
  const penalties = t.get("penalties");
  if (!gallery || !frames || !penalties || gallery.dims.length !== 2 || gallery.dataType !== FLOAT16 || frames.dataType !== INT64 || penalties.dataType !== FLOAT) {
    throw new Error("The search graph isn't in a form the scanner reads");
  }
  const [count, dim] = gallery.dims as [number, number];
  const vectors = new Uint16Array(aligned(gallery.raw));
  const frame64 = new BigInt64Array(aligned(frames.raw));
  const frame = Int32Array.from(frame64, (x) => Number(x));
  const penalty = new Float32Array(aligned(penalties.raw));
  if (vectors.length !== count * dim || frame.length !== count || penalty.length !== count) throw new Error("The search graph isn't in a form the scanner reads");
  return {
    count,
    dim,
    search(embeddings, indices, k) {
      const frameTypes = Math.floor(embeddings.length / dim);
      const best: { index: number; score: number }[] = [];
      for (const i of indices) {
        if (i < 0 || i >= count) continue;
        const f = frame[i]!;
        if (f < 0 || f >= frameTypes) continue;
        let dot = 0;
        const row = i * dim;
        const col = f * dim;
        for (let j = 0; j < dim; j += 1) dot += HALF[vectors[row + j]!]! * embeddings[col + j]!;
        const score = dot - penalty[i]!;
        if (best.length < k || score > best[best.length - 1]!.score) {
          best.push({ index: i, score });
          best.sort((a, b) => b.score - a.score);
          if (best.length > k) best.pop();
        }
      }
      return best;
    },
  };
}
