// The printing look (docs/scanner.md, "The printing look", 20 Nov 2026): most collection scans need
// the printing among several that share one artwork. A look model (the look slot, models.ts)
// embeds the card the camera saw and each candidate printing's own Scryfall picture, and the
// printing list puts the closest first, after any the collector line read. The default never
// settles a printing by itself: one person's 640 px photos are too little evidence for that. The
// option that settles when sure (`look-v1-sure`, opt-in) does, by `lookSettles` below.
//
// Each printing's picture is embedded once per look model by Yama's server too
// (server/src/scan_look.rs, 21 Nov 2026): the look's worker asks it for the printings this device
// hasn't embedded yet (`GET /api/scan/looks`, through artClient.ts) and makes only what it doesn't
// have, so a phone rarely fetches a picture from Scryfall. The server decodes with libjpeg-turbo, as
// Chrome and Android's WebView do, and gives the same numbers there (docs/scanner.md, "Vectors from
// the server"); Safari decodes with Apple's own, which may differ a little.
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

/**
 * Settling by look (docs/scanner.md, "Settling by look", 20 Nov 2026): the look option that settles
 * when sure files the closest printing once it leads the next by this much. The raw lead over the
 * next printing, visual twins included, as the lab measured it (scanner-lab/look_eval.py's first
 * table): at 0.10 v1 settled 45 of one tester's 98 real sleeved photos alone, none wrong; at 0.08,
 * 54 with one wrong.
 */
export const LOOK_SETTLE_LEAD = 0.1;

/**
 * The closest printing and its lead over the next, once every printing in `options` has a score;
 * null while any hasn't (its picture couldn't be had, or the look stopped) or with fewer than two.
 */
export function lookLead(options: readonly { scryfall_id: string }[], scores: LookScores | undefined): { id: string; lead: number } | null {
  if (!scores || options.length < 2) return null;
  const scored = options.map((p) => ({ id: p.scryfall_id, score: scores[p.scryfall_id] }));
  if (scored.some((s) => s.score === undefined || !Number.isFinite(s.score))) return null;
  scored.sort((a, b) => b.score! - a.score!);
  return { id: scored[0]!.id, lead: scored[0]!.score! - scored[1]!.score! };
}

/** Why the look didn't settle a printing: not every printing scored, too small a lead, or the collector line read another. */
export type LookUnsettled = "unscored" | "lead" | "read-other";

/**
 * Whether the look settles the printing by itself (the option that settles when sure): every
 * printing in `options` (the pool the list orders) scored, the closest LOOK_SETTLE_LEAD or more
 * ahead of the next, twins included, and nothing the collector line read pointing to another
 * printing (`readsOther`, evidence.ts `pointsAway`). The lead is given either way, when known.
 */
export function lookSettles(
  options: readonly { scryfall_id: string }[],
  scores: LookScores | undefined,
  readsOther: (id: string) => boolean,
): { settled: true; id: string; lead: number } | { settled: false; why: LookUnsettled; lead: number | null } {
  const top = lookLead(options, scores);
  if (!top) return { settled: false, why: "unscored", lead: null };
  if (top.lead < LOOK_SETTLE_LEAD) return { settled: false, why: "lead", lead: top.lead };
  if (readsOther(top.id)) return { settled: false, why: "read-other", lead: top.lead };
  return { settled: true, id: top.id, lead: top.lead };
}

/** A printing to compare: its Scryfall ID, the picture of the face that was recognised, and whether that's its back. */
export interface LookCandidate {
  id: string;
  url: string;
  back?: boolean;
}

/**
 * The printings to compare, by the picture of the face recognised: a back face's art (`<id>-1` in
 * the gallery) is on each printing's back picture. Printings without that picture are left out.
 */
export function lookCandidates(printings: readonly { scryfall_id: string; image_normal: string | null; back_image_normal: string | null }[], backFace: boolean): LookCandidate[] {
  return printings.flatMap((p) => {
    const url = backFace ? p.back_image_normal : p.image_normal;
    return url ? [{ id: p.scryfall_id, url, back: backFace }] : [];
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

/** The server's answer to `GET /api/scan/looks` (server/src/scan_look.rs). */
export interface ServerLooks {
  /** The look model's SHA-256, or null when the server makes no vectors for it (unknown, withdrawn). */
  model: string | null;
  /** The printings asked about whose vector it has: the ID as asked, the picture it was made from, and the vector. */
  looks: { id: string; url: string; vector: string }[];
  /** Printings asked about that it hasn't made yet (it makes them soon). */
  missing: number;
}

/** Most printings one ask of the server may name (`MAX_IDS`, server/src/scan_look.rs). */
export const SERVER_MAX_IDS = 64;

/** How the server knows a candidate: its Scryfall ID, `-1` after it for a back face (as the art gallery names faces). */
export const serverId = (c: LookCandidate) => (c.back ? `${c.id}-1` : c.id);

const half = (h: number) => {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
};

/** A vector the server made (symbol then card, float16 little-endian, base64); null if it isn't one. */
export function unpackServerLook(b64: string): LookEmbedding | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length === 0 || bin.length % 4) return null;
  const v = new Float32Array(bin.length / 2);
  for (let i = 0; i < v.length; i += 1) v[i] = half(bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8));
  if (!v.every(Number.isFinite)) return null;
  return unpackLook(v);
}

/**
 * The server's vectors for these candidates, by picture URL: only where the server made it from
 * the very picture this device would fetch (the card data could change between two requests).
 */
export function serverKeys(candidates: readonly LookCandidate[], looks: ServerLooks["looks"] | null | undefined): Map<string, LookEmbedding> {
  const out = new Map<string, LookEmbedding>();
  const byId = new Map((looks ?? []).map((l) => [l.id, l]));
  for (const c of candidates) {
    const l = byId.get(serverId(c));
    const key = l && l.url === c.url ? unpackServerLook(l.vector) : null;
    if (key) out.set(c.url, key);
  }
  return out;
}

/** A look's answer from the server, by picture URL: pending until it comes, or is given up (empty). */
export class ServerAnswer {
  /** The answer once it has come; null while it's pending. */
  done: Map<string, LookEmbedding> | null = null;
  readonly promise: Promise<Map<string, LookEmbedding>>;
  private settle: (keys: Map<string, LookEmbedding>) => void = () => undefined;
  constructor() {
    this.promise = new Promise((resolve) => (this.settle = resolve));
  }
  /** The answer has come (or won't: an empty one). Only the first counts. */
  give(keys: Map<string, LookEmbedding>) {
    if (this.done) return;
    this.done = keys;
    this.settle(keys);
  }
  /** An answer already in, for a look that needed nothing from the server. */
  static empty(): ServerAnswer {
    const a = new ServerAnswer();
    a.give(new Map());
    return a;
  }
}

/**
 * A printing's vector (its picture `url`): the server's when its answer is in and has it; made on
 * this device (`own`, fetching and embedding its picture) when the answer is in without it;
 * otherwise made here unless the server's comes first, which stops the making. Made here and
 * failed, it still takes the server's when that comes. So a slow or failed answer from the server
 * never holds a printing up, and a picture the server has is never fetched.
 */
export async function serverOrOwn(
  own: (signal: AbortSignal) => Promise<LookEmbedding>,
  answer: ServerAnswer,
  url: string,
  signal?: AbortSignal,
): Promise<{ key: LookEmbedding; server: boolean }> {
  const ready = answer.done?.get(url);
  if (ready) return { key: ready, server: true };
  if (answer.done) return { key: await own(signal ?? new AbortController().signal), server: false };
  const server = answer.promise.then((keys) => keys.get(url) ?? null);
  const making = new AbortController();
  const stop = () => making.abort();
  if (signal?.aborted) making.abort();
  else signal?.addEventListener("abort", stop, { once: true });
  type Got = { key: LookEmbedding; server: boolean } | { error: unknown };
  const mine: Promise<Got> = own(making.signal).then(
    (key) => ({ key, server: false }),
    (error: unknown) => ({ error }),
  );
  const theirs: Promise<Got | null> = server.then(
    (key) => (key ? { key, server: true } : null),
    () => null,
  );
  try {
    const first = await Promise.race([mine, theirs.then((t) => t ?? mine)]);
    if ("key" in first) {
      if (first.server) making.abort();
      return first;
    }
    const late = await theirs;
    if (late && "key" in late) return late;
    throw first.error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/** A frame kept for the look's query: the recognizer's 640 px frame, the card's quad, and which artworks it matched. */
export interface LookFrame {
  image: RgbaImage;
  quad: Quad;
  /** Gallery indices of every artwork it matched, anywhere and in the set lock's pool. */
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

/** A frame is kept for an artwork it matched at least this well (the art's floor for "having" a card, fuse.ts)… */
export const LOOK_FLOOR = 0.5;
/** …and within this of its best match: a title read can settle on a match a little below the best. */
export const LOOK_NEAR = 0.15;

/**
 * The artworks a frame could be a picture of, each once: those it matched well and near its best
 * (a title read or Not this card can settle on one that wasn't the best; Codex review of #172), not
 * every artwork on its list, so a frame of one card isn't kept for another that merely appears
 * there (re-check of #172). Not filtered by the bundle's printing count: an artwork reprinted since
 * the bundle was made counts one there, and Yama's printings decide.
 */
export function lookTops(matches: readonly { index: number; score: number }[]): number[] {
  const best = Math.max(-Infinity, ...matches.map((m) => m.score));
  return [...new Set(matches.filter((m) => m.score >= LOOK_FLOOR && m.score >= best - LOOK_NEAR).map((m) => m.index))];
}

/** The best match's card in a frame, by name: the ring starts afresh when another card leads. */
export const leadingCard = (matches: readonly { name: string; score: number }[]): string | null =>
  matches.reduce<{ name: string; score: number } | null>((b, m) => (!b || m.score > b.score ? m : b), null)?.name ?? null;

/**
 * The printing list for a Wrong printing: the printing said to be wrong goes last, after the
 * look's order, and is never the look's best guess (re-check of #172).
 */
export function withoutMisread<P extends { scryfall_id: string }>(list: readonly P[], misread: string | undefined): P[] {
  if (!misread) return [...list];
  return [...list.filter((p) => p.scryfall_id !== misread), ...list.filter((p) => p.scryfall_id === misread)];
}

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
  /** Printings compared, how many came from this device's cache, and the time spent fetching, decoding and embedding the rest. */
  scored: number;
  cached: number;
  /**
   * Printings the server was asked about (those not in this device's cache), how many of the
   * vectors used came from it, and how long its answer took (null when it wasn't asked or didn't
   * answer). Absent from records before 21 Nov 2026.
   */
  asked?: number;
  server?: number;
  serverMs?: number | null;
  fetchMs: number;
  decodeMs: number;
  embedMs: number;
  ms: number;
}

/** One timing of the look (the speed test, speed.ts): a printing's picture and a frame, embedded once each. */
export interface LookTiming {
  fetchMs: number;
  decodeMs: number;
  /** Embedding the printing's picture with its own corners as the quad. */
  pictureMs: number;
  /** Embedding the card in a frame (null when no frame was given). */
  frameMs: number | null;
}

/**
 * What the timing record keeps of a finished look (Scanner diagnostics, `get_scan_timings`): its
 * milliseconds, the printings scored, and where their vectors came from.
 */
export const lookTimingDetail = (done: LookDone) => ({
  look_ms: Math.round(done.ms),
  look_scored: done.scored,
  look_cached: done.cached,
  look_server: done.server ?? 0,
  look_made: Math.max(0, done.scored - done.cached - (done.server ?? 0)),
});

export type LookWorkerRequest =
  /** `cache: false` (the speed test): load the model and leave the printings' cache as it is. */
  | { type: "model"; id: number; url: string; bytes: number; cache?: boolean }
  | { type: "look"; id: number; frames: WireFrame[]; candidates: LookCandidate[] }
  /** The server's answer for a look's `need` (null when it couldn't be had), and how long it took. */
  | { type: "keys"; id: number; looks: ServerLooks["looks"] | null; ms: number | null }
  | { type: "stop"; id: number }
  /** Time the look on this picture and frame, keeping nothing (the speed test). */
  | { type: "time"; id: number; url: string; frame: WireFrame | null };

export type LookWorkerReply =
  | { type: "ready"; id: number; error: string | null }
  /** A look's printings this device has no vector for: artClient asks the server for them (model: the look model's file name). */
  | { type: "need"; id: number; model: string; candidates: LookCandidate[] }
  | { type: "score"; id: number; candidate: string; score: number }
  | ({ type: "done"; id: number; error: string | null } & LookDone)
  | ({ type: "timed"; id: number; error: string | null } & LookTiming);

