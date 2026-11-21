// The printing look (docs/scanner.md, "The printing look", 20 Nov 2026): most collection scans need
// the printing among several that share one artwork. A look model (the look slot, models.ts)
// embeds the card the camera saw and each candidate printing's own Scryfall picture, and the
// printing list puts the closest first, after any the collector line read. It never settles a
// printing by itself: one person's 640 px photos are too little evidence for that.
//
// The model has the bundle's embed.onnx interface: `scene` (H × W × 4 RGBA uint8) and `quad`
// (4 × 2 float32, the card's corners from top-left, clockwise, in scene pixels); it warps the card
// itself and gives `symbol` and `card` (1 × 128, L2-normalised). A printing's picture is run with
// its own corners as the quad.

import type { Quad, RgbaImage } from "./types";

export interface LookEmbedding {
  symbol: Float32Array;
  card: Float32Array;
}

/** How much the set symbol's area counts against the whole card (the lab's best mix, 20 Nov 2026). */
export const SYMBOL_WEIGHT = 0.8;

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) s += a[i]! * b[i]!;
  return s;
};

/** How alike a printing's picture (`key`) looks to the card seen (`query`): 0.8 × symbol cosine + 0.2 × card cosine. */
export const lookScore = (query: LookEmbedding, key: LookEmbedding) => SYMBOL_WEIGHT * dot(query.symbol, key.symbol) + (1 - SYMBOL_WEIGHT) * dot(query.card, key.card);

const normalised = (v: Float32Array) => {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
};

/** The average of several frames' embeddings, each part renormalised; null for none. */
export function meanEmbedding(list: readonly LookEmbedding[]): LookEmbedding | null {
  const first = list[0];
  if (!first) return null;
  const sum = (part: "symbol" | "card") => {
    const out = new Float32Array(first[part].length);
    for (const e of list) for (let i = 0; i < out.length; i += 1) out[i]! += e[part][i] ?? 0;
    return normalised(out);
  };
  return { symbol: sum("symbol"), card: sum("card") };
}

/** A whole picture's corners, top-left first and clockwise: the quad for a printing's own scan. */
export const cornersOf = (width: number, height: number): Quad => [
  [0, 0],
  [width, 0],
  [width, height],
  [0, height],
];

/** The parts of onnxruntime-web the look uses (the worker passes it in; Node's eval passes its own). */
export interface LookSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
  release?(): Promise<void>;
}
export type LookTensor = new (type: "uint8" | "float32", data: Uint8Array | Float32Array, dims: readonly number[]) => unknown;

/** The look model's embedding of the card at `quad` in `image`. */
export async function embedLook(session: LookSession, Tensor: LookTensor, image: RgbaImage, quad: Quad): Promise<LookEmbedding> {
  const scene = new Tensor("uint8", new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), [image.height, image.width, 4]);
  const out = await session.run({ scene, quad: new Tensor("float32", Float32Array.from(quad.flat()), [4, 2]) });
  return { symbol: Float32Array.from(out.symbol!.data as Float32Array), card: Float32Array.from(out.card!.data as Float32Array) };
}

/** Each printing's look score so far, by Scryfall ID. */
export type LookScores = Record<string, number>;

/**
 * The printing list in look order: the first `readFirst` (put there by a collector-line read) stay
 * as they are, then the rest by look score, best first, and those not scored yet after them in the
 * order they came. Stable, so a list fills in without the unscored ones jumping about.
 */
export function lookOrder<P extends { scryfall_id: string }>(options: readonly P[], readFirst: number, scores: LookScores | undefined): P[] {
  if (!scores || Object.keys(scores).length === 0) return [...options];
  const head = options.slice(0, readFirst);
  const rest = options.slice(readFirst);
  const scored = rest.filter((p) => scores[p.scryfall_id] !== undefined).sort((a, b) => scores[b.scryfall_id]! - scores[a.scryfall_id]!);
  return [...head, ...scored, ...rest.filter((p) => scores[p.scryfall_id] === undefined)];
}

/** The look's best guess: the best-scored printing once at least two are scored, else null. */
export function lookBest(scores: LookScores | undefined): string | null {
  const ids = Object.keys(scores ?? {});
  if (ids.length < 2) return null;
  return ids.reduce((best, id) => (scores![id]! > scores![best]! ? id : best));
}

/** A printing to compare: its Scryfall ID and the picture of the face that was recognised. */
export interface LookCandidate {
  id: string;
  url: string;
}

/**
 * The printings to compare, by the picture of the face recognised: a back face's art (`<id>-1` in
 * the gallery) is on each printing's back picture. Printings without that picture are left out.
 */
export function lookCandidates(printings: readonly { scryfall_id: string; image_normal: string | null; back_image_normal: string | null }[], backFace: boolean): LookCandidate[] {
  return printings.flatMap((p) => {
    const url = backFace ? p.back_image_normal : p.image_normal;
    return url ? [{ id: p.scryfall_id, url }] : [];
  });
}

/**
 * Score `candidates` against `query`, `concurrency` at a time, reporting each as it's done
 * (`onScore`); stops starting new ones once `signal` aborts. A candidate whose picture can't be
 * had is skipped. Resolves to how many were scored.
 */
export async function scoreCandidates(
  query: LookEmbedding,
  candidates: readonly LookCandidate[],
  embedKey: (c: LookCandidate, signal?: AbortSignal) => Promise<LookEmbedding>,
  onScore: (id: string, score: number) => void,
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const queue = [...candidates];
  let scored = 0;
  const lane = async () => {
    for (let c = queue.shift(); c && !opts.signal?.aborted; c = queue.shift()) {
      try {
        const key = await embedKey(c, opts.signal);
        if (opts.signal?.aborted) return;
        onScore(c.id, lookScore(query, key));
        scored += 1;
      } catch (e) {
        if (opts.signal?.aborted) return;
        console.warn(`The look couldn't compare printing ${c.id}`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, lane));
  return scored;
}

/** A frame kept for the look's query: the recognizer's 640 px frame, the card's quad, and which artworks it matched. */
export interface LookFrame {
  image: RgbaImage;
  quad: Quad;
  /** Gallery indices of every artwork it matched (anywhere and in the set lock's pool) that several printings share. */
  tops: number[];
}

/**
 * The last few frames with a card in them, for the look's query. Copies go into buffers it reuses,
 * so keeping frames at camera rate makes no garbage once the ring is full.
 */
export class LookFrames {
  private frames: LookFrame[] = [];
  private spare: Uint8ClampedArray[] = [];
  constructor(private readonly keep = 3) {}
  /** Keep a copy of this frame (`data`, RGBA) with the card at `quad` and the artworks it matched. */
  add(width: number, height: number, data: Uint8ClampedArray, quad: Quad, tops: number[]) {
    let buf = this.frames.length >= this.keep ? this.frames.shift()!.image.data : this.spare.pop();
    if (!buf || buf.length !== data.length) buf = new Uint8ClampedArray(data.length);
    buf.set(data);
    this.frames.push({ image: { width, height, data: buf }, quad, tops });
  }
  /** No card in view: the frames kept are of a card that has gone (the next may be another copy of the same art). */
  clear() {
    for (const f of this.frames) if (this.spare.length < this.keep) this.spare.push(f.image.data);
    this.frames = [];
  }
  /** Newest last: the frames that matched this artwork. */
  of(index: number): LookFrame[] {
    return this.frames.filter((f) => f.tops.includes(index));
  }
}

/** The artworks a frame matched that a look could be asked about: those several printings share. */
export const lookTops = (matches: readonly { index: number; printings: number }[]): number[] => [...new Set(matches.filter((m) => m.printings > 1).map((m) => m.index))];

/** Embeddings packed as one buffer for the Cache API (symbol then card), and back. */
export const packLook = (e: LookEmbedding): Float32Array => {
  const out = new Float32Array(e.symbol.length + e.card.length);
  out.set(e.symbol, 0);
  out.set(e.card, e.symbol.length);
  return out;
};
export const unpackLook = (v: Float32Array): LookEmbedding | null => {
  if (v.length === 0 || v.length % 2) return null;
  const half = v.length / 2;
  return { symbol: v.slice(0, half), card: v.slice(half) };
};

/** A frame handed to the look worker: the recognizer's frame (RGBA) and the card's quad in it. */
export interface WireFrame {
  width: number;
  height: number;
  quad: Quad;
  buffer: ArrayBuffer;
}

/** How a look at one card's printings went, for its diagnostics record. */
export interface LookDone {
  /** The look model's file, as the cache keys it. */
  model: string;
  /** Frames averaged for the card's side, and how long that took. */
  frames: number;
  queryMs: number;
  /** Printings compared, how many came from the cache, and the time spent fetching, decoding and embedding the rest. */
  scored: number;
  cached: number;
  fetchMs: number;
  decodeMs: number;
  embedMs: number;
  ms: number;
}

export type LookWorkerRequest =
  | { type: "model"; id: number; url: string; bytes: number }
  | { type: "look"; id: number; frames: WireFrame[]; candidates: LookCandidate[] }
  | { type: "stop"; id: number };

export type LookWorkerReply =
  | { type: "ready"; id: number; error: string | null }
  | { type: "score"; id: number; candidate: string; score: number }
  | ({ type: "done"; id: number; error: string | null } & LookDone);

