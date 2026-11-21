// Card recognition by artwork: find the card anywhere in a frame, then match its art against
// one vector per Scryfall illustration. Runs the three graphs of a ManaVault/oracle scanner
// bundle (MPL-2.0 weights, served by our server: see server/src/scan_bundle.rs). The glue is
// our own; docs/scanner.md has the measurements and the licence notes.
//
//   frame ─▶ detector on the middle square ─▶ detector again on a window around the card
//         ─▶ embed (the graph warps the card itself) ─▶ search ─▶ top 5 illustrations
//
// The onnxruntime namespace is passed in, so the web worker and the Node eval share this file.

import { artLead, LEAD_MARGIN } from "./fuse";
import { fromBase64, galleryOf, readGallery, upTo, type Gallery } from "./gallery";
import type { Point, Quad, RgbaImage } from "./types";

/** `manifest.constants` of the bundle. */
export interface BundleConstants {
  /** Side of the first detector window, in frame pixels. */
  scene: number;
  /** Side of the detector's input. */
  det_input: number;
  /** Views the detector votes over; its `up` output sums one unit vector per view. */
  rotations: number;
  /** Share of the second window the card's long side should fill. */
  refine_fill: number;
  refine_min_side: number;
  card_aspect: number;
  /** The embed graph's frame cuts, in its output's row order ("modern", "old", …). */
  frame_names?: string[];
}

/** One gallery illustration, in gallery order. */
export interface Art {
  /** Scryfall ID of a printing with this art; a back face is `<id>-1`. */
  id: string;
  name: string;
  set: string;
  number: string;
  illustrationId: string | null;
  layout: string;
  /** Printings that share this art, all languages (from the bundle). */
  printings: number;
}

export interface ArtMatch extends Art {
  index: number;
  /** Cosine similarity less the bundle's frame and hub penalties. Right answers score about 0.8 to 0.99. */
  score: number;
}

export interface Recognition {
  /** The card's corners in frame pixels, top-left first as printed, or null when no card is in view. */
  quad: Quad | null;
  /** Share of the detector's views that agreed on the card's top (0 to 1). */
  upright: number;
  /** Best first. Empty when no card is in view. */
  matches: ArtMatch[];
  /**
   * With a pool set (the set lock): the best matches among the pool's artworks only, best first.
   * Scored exactly as `matches` are, so the two compare directly.
   */
  pool?: ArtMatch[];
  /**
   * `cuts`: frame cuts the art model embedded (all of them, or fewer when the first stage of a cascade
   * settled it). `runs`: each graph run's milliseconds this frame, by graph (the speed test, speed.ts,
   * reads them: a detector pass, the art embedding, the search).
   */
  timings: { detectMs: number; embedMs: number; totalMs: number; cuts?: number; runs?: GraphRuns };
}

/** Milliseconds of each graph run in one frame, in the order they ran. */
export interface GraphRuns {
  detector: number[];
  embed: number[];
  search: number[];
}

export interface Recognizer {
  identify(frame: RgbaImage): Promise<Recognition>;
  /** Forget the tracked card (after it was accepted, say). */
  reset(): void;
  /**
   * Also search just these artworks (gallery indices) each frame, into `Recognition.pool`; null
   * stops. False when the bundle's search graph can't be read for this (then nothing is pooled).
   */
  setPool(indices: number[] | null): boolean;
  /**
   * Match with this embed graph from now on (another art query model with the same inputs and
   * output: models.ts). It's compiled and warmed before it takes over, so frames meanwhile use the
   * one before; a graph that fails to load leaves that one running.
   */
  setEmbed(graph: Uint8Array): Promise<void>;
  /**
   * Find cards with this detector graph from now on (another card finder with the bundle detector's
   * input and outputs: models.ts). Compiled and warmed first, as setEmbed; one that fails to load or
   * run leaves the one before running.
   */
  setDetector(graph: Uint8Array): Promise<void>;
}

/** Pool matches kept per frame. */
const POOL_TOP = 3;

/** The parts of onnxruntime-web this uses. */
export interface OrtLike {
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<Session> };
  Tensor: new (type: "uint8" | "float32" | "int64", data: Uint8Array | Float32Array | BigInt64Array, dims: readonly number[]) => unknown;
}

/**
 * The embed cascade. An embed graph with a `cuts` input (int64, which of its frame cuts to embed; the
 * others' rows come back as zeros, which the search scores at minus their penalty) is run on the modern
 * and old cuts first: 92% of the gallery's rows are in those frames, and two cuts cost about a ninth of
 * the network's time for 17. When that alone puts a card FIRST_FLOOR or more and LEAD_MARGIN ahead of
 * every other card listed (artLead, as the live lead rule judges), that's the frame's answer; otherwise
 * the other cuts are embedded too and everything is searched, as without the cascade. Measured offline
 * on yama-art-20261118 (cardvision lab, 20 Nov 2026): on 1,840 held-out simulated captures, the lead
 * rule locked the same 96.2% right, 0 wrong and 9 unknown cards as all 17 cuts, with 89.8% settled by
 * the first stage; on the 124 real photos, the same 94.4%, 0 wrong, 87.1% by the first stage. At 0.65
 * the first stage locked 2 simulated captures wrongly (a Murder as Demonic Consultation, a Spirit token
 * as Arcane Signet), so it asks for more than the lead rule.
 */
export const FIRST_STAGE = ["modern", "old"];
export const FIRST_FLOOR = 0.68;
interface Session {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
  release?(): Promise<void>;
}

/** Detector votes below this saw nothing card-like (empty tables vote under 0.2, cards over 0.9). */
const EMPTY = 0.25;
/** A card is in view at this vote and at least this short side in frame pixels. */
const IN_VIEW = 0.5;
const MIN_SHORT = 60;
/**
 * Below this, the found "card" is a plain surface: no frame, title or rules text. Mean brightness
 * step between neighbouring samples of a 32 × 44 grid over the card (0 to 255; `cardDetail`). Scryfall scans and
 * photographed cards measure well above it; a white sheet, a wall or a sleeve back well below.
 * Without it a blank white view matched Mystery Booster 2's Whiteout, whose art box is printed
 * blank (Bryan, 13 Nov 2026).
 */
export const MIN_DETAIL = 4;
/** Re-run the whole-scene pass at least this often while tracking, so tracking can't stick. */
const RETRACK_EVERY = 8;

interface Window {
  cx: number;
  cy: number;
  side: number;
}

interface Detection {
  quad: Quad;
  vote: number;
  centre: Point;
  short: number;
}

/**
 * The `side` px square around (cx, cy), resampled bilinearly to `size` px with edges repeated
 * past the frame. Window pixel = k · (frame pixel − centre) + size / 2, with k = size / side, on
 * integer pixel coordinates (OpenCV's warpAffine convention, which the detector was trained with).
 */
export function sampleWindow(frame: RgbaImage, w: Window, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const k = size / w.side;
  const { width, height, data } = frame;
  for (let j = 0; j < size; j += 1) {
    const fy = Math.min(height - 1, Math.max(0, (j - size / 2) / k + w.cy));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const ty = fy - y0;
    for (let i = 0; i < size; i += 1) {
      const fx = Math.min(width - 1, Math.max(0, (i - size / 2) / k + w.cx));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const tx = fx - x0;
      const a = (y0 * width + x0) * 4;
      const b = (y0 * width + x1) * 4;
      const c = (y1 * width + x0) * 4;
      const d = (y1 * width + x1) * 4;
      const o = (j * size + i) * 4;
      for (let ch = 0; ch < 3; ch += 1) {
        const top = data[a + ch]! + (data[b + ch]! - data[a + ch]!) * tx;
        const bottom = data[c + ch]! + (data[d + ch]! - data[c + ch]!) * tx;
        out[o + ch] = Math.round(top + (bottom - top) * ty);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

const toFrame = (p: Point, w: Window, size: number): Point => {
  const k = size / w.side;
  return [(p[0] - size / 2) / k + w.cx, (p[1] - size / 2) / k + w.cy];
};

/**
 * How much is printed inside `quad`: the mean absolute brightness step between neighbouring
 * points of a grid laid across it (5% in from each edge, so the table around doesn't count),
 * each point a small average so sensor noise doesn't count either.
 */
export function cardDetail(frame: RgbaImage, quad: Quad): number {
  const [a, b, c, d] = quad;
  const cols = 32;
  const rows = 44;
  const lum = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const v = 0.05 + (0.9 * j) / (rows - 1);
    for (let i = 0; i < cols; i++) {
      const u = 0.05 + (0.9 * i) / (cols - 1);
      // Bilinear across the four corners (top-left, top-right, bottom-right, bottom-left).
      const x = (1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]);
      const y = (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1]);
      // A 5 × 5 average at each point, so camera noise on a blank surface doesn't read as print.
      let total = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const px = Math.min(frame.width - 1, Math.max(0, Math.round(x) + dx));
          const py = Math.min(frame.height - 1, Math.max(0, Math.round(y) + dy));
          const k = (py * frame.width + px) * 4;
          total += 0.299 * frame.data[k]! + 0.587 * frame.data[k + 1]! + 0.114 * frame.data[k + 2]!;
          count++;
        }
      }
      lum[j * cols + i] = total / count;
    }
  }
  let sum = 0;
  let n = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const here = lum[j * cols + i]!;
      if (i + 1 < cols) (sum += Math.abs(here - lum[j * cols + i + 1]!)), n++;
      if (j + 1 < rows) (sum += Math.abs(here - lum[(j + 1) * cols + i]!)), n++;
    }
  }
  return n ? sum / n : 0;
}

const shortSide = (q: Quad) => Math.min(...q.map((p, i) => Math.hypot(q[(i + 1) % 4]![0] - p[0], q[(i + 1) % 4]![1] - p[1])));

/** Whether the quad is a convex quadrilateral: every turn along its edges is the same way. */
export function convex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [q[i]!, q[(i + 1) % 4]!, q[(i + 2) % 4]!];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0 || (sign && Math.sign(cross) !== sign)) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/**
 * The part of the frame the embed graph reads for this quad: the quad's bounding box and a few pixels
 * beyond (bilinear sampling reads the next pixel too), within the frame, with the quad moved to match.
 * The graph converts the whole scene to float before it warps the card out of it; given just the card's
 * box it does that for about a third of the pixels and returns the same embeddings (largest difference
 * 3e-4, cosine 0.999999, on simulated frames; cardvision lab, 20 Nov 2026): the graph normalises the
 * warp's grid by the scene's own size, so a cut scene only shifts it. Past the frame's edge the graph
 * pads with zeros, so the box stops at the frame's edge exactly as the frame does.
 */
export function cardWindow(frame: RgbaImage, quad: Quad): { frame: RgbaImage; quad: Quad } {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const x1 = Math.min(frame.width, Math.ceil(Math.max(...xs)) + 3);
  const y1 = Math.min(frame.height, Math.ceil(Math.max(...ys)) + 3);
  const whole = x0 === 0 && y0 === 0 && x1 === frame.width && y1 === frame.height;
  // Nothing to gain, or a quad off the frame or folded over itself (a corner dragged past the diagonal
  // samples far outside the corners' box): the frame as it is.
  if (whole || !(x1 - x0 >= 2 && y1 - y0 >= 2) || [...xs, ...ys].some((v) => !Number.isFinite(v)) || !convex(quad)) return { frame, quad };
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) data.set(frame.data.subarray(((y0 + y) * frame.width + x0) * 4, ((y0 + y) * frame.width + x1) * 4), y * w * 4);
  return { frame: { width: w, height: h, data }, quad: quad.map(([x, y]) => [x - x0, y - y0]) as Quad };
}

/**
 * Artworks the bundle doesn't know, embedded by Yama's server with the bundle's own embedding
 * graph (server/src/scan_art.rs): their index rows and a gallery scored like the graph's.
 */
export interface Supplement {
  arts: Art[];
  gallery: Gallery;
}

/** The server's supplement file. Throws when it isn't for this bundle or doesn't add up. */
export function parseSupplement(json: unknown, bundleVersion?: string): Supplement {
  const s = json as { bundle?: string; dim?: number; frames?: number[]; penalties?: number[]; vectors?: string };
  if (!s || typeof s !== "object" || !Array.isArray(s.frames) || !Array.isArray(s.penalties) || typeof s.vectors !== "string" || typeof s.dim !== "number") {
    throw new Error("The artwork supplement isn't in a form the scanner reads");
  }
  if (bundleVersion && s.bundle !== bundleVersion) throw new Error(`The artwork supplement is for bundle ${s.bundle}, not ${bundleVersion}`);
  const arts = parseArts(json);
  const bytes = fromBase64(s.vectors);
  const vectors = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const gallery = galleryOf(vectors, Int32Array.from(s.frames), Float32Array.from(s.penalties), s.dim);
  if (gallery.count !== arts.length) throw new Error("The artwork supplement's rows don't match its vectors");
  return { arts, gallery };
}

/** Best first, at most `k`, from lists that are each best first. */
const mergeTop = (k: number, ...lists: ArtMatch[][]): ArtMatch[] => lists.flat().sort((a, b) => b.score - a.score).slice(0, k);

/**
 * `arts` is the bundle's index (the search graph's rows). A supplement's artworks follow it,
 * numbered from `arts.length` up, so `ArtMatch.index` and the set lock's pool cover both
 * (`poolIndices` over `arts` then `supplement.arts`). `hidden` (evals only) takes bundle rows out
 * of the search, to test the supplement on artworks the bundle has.
 */
export async function createRecognizer(
  ort: OrtLike,
  graphs: { detector: Uint8Array; embed: Uint8Array; search: Uint8Array },
  constants: BundleConstants,
  arts: Art[],
  supplement?: Supplement | null,
  /** `cascade: false` embeds every cut at once even when the art model could cascade (a GPU gains nothing from it). */
  extras: { hidden?: number[]; cascade?: boolean } = {},
): Promise<Recognizer> {
  const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  // One at a time: three parallel compiles peak higher in memory, which phones notice.
  let detector = await ort.InferenceSession.create(graphs.detector, options);
  let embed = await ort.InferenceSession.create(graphs.embed, options);
  const search = await ort.InferenceSession.create(graphs.search, options);
  // Bundles since gallery-20261106 (manifest `search_mask`) also take `mask`, one value per
  // artwork in arts.json order: above 0 competes, 0 scores -3. Ones search the whole gallery,
  // exactly as the graph without the input does. Older bundles take only `embeddings`.
  const masked = search.inputNames.includes("mask");
  const hidden = new Set(extras.hidden ?? []);
  if (hidden.size && !masked) throw new Error("This bundle's search graph can't hide artworks");
  const maskValues = new Float32Array(arts.length).fill(1);
  for (const i of hidden) if (i >= 0 && i < arts.length) maskValues[i] = 0;
  const everyArt = masked ? new ort.Tensor("float32", maskValues, [arts.length]) : null;
  const extra = supplement ?? null;
  const bundleCount = arts.length;
  let gallery: Gallery | null = null;
  try {
    gallery = readGallery(graphs.search);
  } catch (e) {
    console.warn("The set lock can't search this bundle", e);
  }
  let pool: number[] | null = null;
  const size = constants.det_input;
  const now = () => performance.now();

  // Each graph run's time, into the frame's own record (Recognition.timings.runs): passed down, so a
  // model switch warming up meanwhile never counts in a frame's.
  const noRuns = (): GraphRuns => ({ detector: [], embed: [], search: [] });
  const timed = async <T>(into: GraphRuns, graph: keyof GraphRuns, run: () => Promise<T>): Promise<T> => {
    const t = now();
    const out = await run();
    into[graph].push(now() - t);
    return out;
  };

  const detect = async (frame: RgbaImage, w: Window, session: Session = detector, into: GraphRuns = noRuns()): Promise<Detection> => {
    const window = new ort.Tensor("uint8", sampleWindow(frame, w, size), [size, size, 4]);
    const out = await timed(into, "detector", () => session.run({ window }));
    const q = out.quad!.data as Float32Array;
    const up = out.up!.data as Float32Array;
    const c = out.centre!.data as Float32Array;
    return {
      quad: [0, 1, 2, 3].map((i) => toFrame([q[i * 2]!, q[i * 2 + 1]!], w, size)) as Quad,
      vote: Math.hypot(up[0]!, up[1]!) / constants.rotations,
      centre: toFrame([c[0]!, c[1]!], w, size),
      short: (out.short!.data as Float32Array)[0]! * (w.side / size),
    };
  };
  // The second pass: the card's long side fills `refine_fill` of the window.
  const around = (d: Detection): Window => ({
    cx: d.centre[0],
    cy: d.centre[1],
    side: Math.max((d.short * constants.card_aspect) / constants.refine_fill, constants.refine_min_side),
  });

  // The cascade (FIRST_STAGE): which cuts each stage embeds, for an embed graph that takes `cuts`.
  const frameNames = constants.frame_names ?? [];
  const allCuts = frameNames.map((_, i) => i);
  const firstCuts = allCuts.filter((i) => FIRST_STAGE.includes(frameNames[i]!));
  const otherCuts = allCuts.filter((i) => !FIRST_STAGE.includes(frameNames[i]!));
  const stagesFor = (session: Session) =>
    extras.cascade !== false && session.inputNames.includes("cuts") && firstCuts.length === FIRST_STAGE.length && otherCuts.length ? { first: firstCuts, rest: otherCuts } : null;
  /** The first stage settles the frame: a card FIRST_FLOOR or more, LEAD_MARGIN ahead of every other card listed. */
  const settles = (out: ArtMatch[]) => !!out[0] && out[0].score >= FIRST_FLOOR && artLead(out) >= LEAD_MARGIN;
  /** The embed graph's output for these cuts (every cut when it takes `cuts` and none are named). */
  const embedRun = async (session: Session, whole: RgbaImage, at: Quad, cuts?: number[], into: GraphRuns = noRuns()) => {
    const takesCuts = session.inputNames.includes("cuts");
    if (takesCuts && !frameNames.length) throw new Error("This art model needs the bundle's frame names");
    const { frame, quad } = cardWindow(whole, at);
    const scene = new ort.Tensor("uint8", new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), [frame.height, frame.width, 4]);
    const feeds: Record<string, unknown> = { scene, quad: new ort.Tensor("float32", Float32Array.from(quad.flat()), [4, 2]) };
    if (takesCuts) {
      const c = cuts ?? allCuts;
      feeds.cuts = new ort.Tensor("int64", BigInt64Array.from(c, (i) => BigInt(i)), [c.length]);
    }
    return Object.values(await timed(into, "embed", () => session.run(feeds)))[0]!;
  };
  const match = async (frame: RgbaImage, quad: Quad, into: GraphRuns = noRuns()): Promise<{ matches: ArtMatch[]; pool?: ArtMatch[]; cuts?: number }> => {
    const fromExtra = (vector: Float32Array, local: Iterable<number>, k: number): ArtMatch[] =>
      extra ? extra.gallery.search(vector, local, k).flatMap(({ index, score }) => (extra.arts[index] ? [{ ...extra.arts[index]!, index: bundleCount + index, score }] : [])) : [];
    const rank = async (embedding: unknown): Promise<ArtMatch[]> => {
      const ranked = await timed(into, "search", () => search.run(everyArt ? { embeddings: embedding, mask: everyArt } : { embeddings: embedding }));
      const indices = ranked.indices!.data as BigInt64Array | Int32Array;
      const scores = ranked.scores!.data as Float32Array;
      const graphTop: ArtMatch[] = [];
      for (let i = 0; i < indices.length; i += 1) {
        const index = Number(indices[i]);
        const art = arts[index];
        // A masked or padded row scores below -1; real scores are cosines.
        if (art && scores[i]! >= -1) graphTop.push({ ...art, index, score: scores[i]! });
      }
      const vector = (embedding as { data: Float32Array }).data;
      // The supplement is scored exactly as the graph scores its rows, so the two merge by score.
      return extra ? mergeTop(Math.max(indices.length, 1), graphTop, fromExtra(vector, upTo(extra.gallery.count), indices.length)) : graphTop;
    };
    // The session and pool this frame runs with (setEmbed and setPool may change them meanwhile).
    // With the set lock every cut is embedded at once: the pool's best can be in any frame.
    const session = embed;
    const lockPool = pool;
    const cascade = lockPool ? null : stagesFor(session);
    let embedding: unknown = await embedRun(session, frame, quad, cascade?.first, into);
    let out = await rank(embedding);
    let cuts = cascade ? cascade.first.length : frameNames.length || undefined;
    if (cascade && !settles(out)) {
      const first = (embedding as { data: Float32Array }).data;
      const rest = ((await embedRun(session, frame, quad, cascade.rest, into)) as { data: Float32Array }).data;
      // Each stage fills only its own cuts' rows, so the whole embedding is their sum.
      const sum = Float32Array.from(first, (v, i) => v + rest[i]!);
      embedding = new ort.Tensor("float32", sum, [frameNames.length, sum.length / frameNames.length]);
      out = await rank(embedding);
      cuts = frameNames.length;
    }
    const vector = (embedding as { data: Float32Array }).data;
    if (!lockPool || !gallery) return { matches: out, cuts };
    const main = lockPool.filter((i) => i < bundleCount && !hidden.has(i));
    const local = lockPool.filter((i) => i >= bundleCount).map((i) => i - bundleCount);
    const pooled = mergeTop(
      POOL_TOP,
      gallery.search(vector, main, POOL_TOP).flatMap(({ index, score }) => (arts[index] ? [{ ...arts[index]!, index, score }] : [])),
      fromExtra(vector, local, POOL_TOP),
    );
    return { matches: out, pool: pooled, cuts };
  };

  let tracked: Window | null = null;
  let trackedFor = 0;

  const identify = async (frame: RgbaImage): Promise<Recognition> => {
    const t0 = now();
    const runs = noRuns();
    let fine: Detection | null = null;
    // While the card stays put, one pass on last frame's card window is enough.
    if (tracked && trackedFor < RETRACK_EVERY) {
      const d = await detect(frame, tracked, detector, runs);
      const next = around(d);
      const moved = Math.hypot(next.cx - tracked.cx, next.cy - tracked.cy);
      const ratio = next.side / tracked.side;
      if (d.vote >= EMPTY && moved <= tracked.side * 0.1 && ratio >= 0.8 && ratio <= 1.25) fine = d;
    }
    const wasTracking = !!fine;
    if (!fine) {
      const centre = { cx: frame.width / 2, cy: frame.height / 2 };
      let coarse = await detect(frame, { ...centre, side: constants.scene }, detector, runs);
      // A card held close can overflow the middle square; look at the whole frame too.
      const whole = Math.max(frame.width, frame.height);
      if (coarse.vote < EMPTY && whole > constants.scene * 1.1) coarse = await detect(frame, { ...centre, side: whole }, detector, runs);
      fine = coarse.vote >= EMPTY ? await detect(frame, around(coarse), detector, runs) : coarse;
    }
    const t1 = now();
    const inView = fine.vote >= IN_VIEW && shortSide(fine.quad) >= MIN_SHORT && cardDetail(frame, fine.quad) >= MIN_DETAIL;
    tracked = inView ? around(fine) : null;
    trackedFor = inView && wasTracking ? trackedFor + 1 : 0;
    const { cuts, ...found } = inView ? await match(frame, fine.quad, runs) : { matches: [], pool: pool && gallery ? [] : undefined, cuts: 0 };
    const t2 = now();
    return { quad: inView ? fine.quad : null, upright: fine.vote, ...found, timings: { detectMs: t1 - t0, embedMs: t2 - t1, totalMs: t2 - t0, cuts, runs } };
  };

  // Each graph's first run sets up its kernels; pay that before the first real frame.
  const blank: RgbaImage = { width: constants.scene, height: constants.scene, data: new Uint8ClampedArray(constants.scene ** 2 * 4).fill(255) };
  await identify(blank);
  const h = constants.scene / 2;
  const blankQuad: Quad = [[h - 125, h - 175], [h + 125, h - 175], [h + 125, h + 175], [h - 125, h + 175]];
  await match(blank, blankQuad);
  tracked = null;

  return {
    identify,
    reset() {
      tracked = null;
      trackedFor = 0;
    },
    setPool(indices) {
      if (!gallery) {
        pool = null;
        return false;
      }
      pool = indices;
      return true;
    },
    async setEmbed(graph) {
      const next = await ort.InferenceSession.create(graph, options);
      try {
        await embedRun(next, blank, blankQuad);
      } catch (e) {
        await next.release?.().catch(() => undefined);
        throw e;
      }
      const old = embed;
      embed = next;
      // A frame already being matched may still be running the old one: let it finish first.
      setTimeout(() => void old.release?.().catch(() => undefined), 5000);
    },
    async setDetector(graph) {
      const next = await ort.InferenceSession.create(graph, options);
      try {
        // Its outputs must be the bundle detector's: a pass on a blank window reads them all.
        const d = await detect(blank, { cx: constants.scene / 2, cy: constants.scene / 2, side: constants.scene }, next);
        if (![...d.quad.flat(), ...d.centre, d.vote, d.short].every(Number.isFinite)) throw new Error("This card finder's outputs aren't the bundle detector's");
      } catch (e) {
        await next.release?.().catch(() => undefined);
        throw e;
      }
      const old = detector;
      detector = next;
      tracked = null;
      setTimeout(() => void old.release?.().catch(() => undefined), 5000);
    },
  };
}

/** The gallery indices of the artworks these printings show (by illustration, or by the printing itself). */
export function poolIndices(gallery: Art[], keys: { illustrations: string[]; ids: string[] }): number[] {
  const ills = new Set(keys.illustrations);
  const ids = new Set(keys.ids);
  const out: number[] = [];
  gallery.forEach((a, i) => {
    if ((a.illustrationId && ills.has(a.illustrationId)) || ids.has(a.id.replace(/-1$/, ""))) out.push(i);
  });
  return out;
}

/**
 * The artwork index: the server's slim form (`{ columns, rows }`, see server/src/scan.rs) or the
 * bundle's own arts.json (a list of objects). Gallery order is kept: it is the search graph's index.
 */
export function parseArts(json: unknown): Art[] {
  if (json && typeof json === "object" && "rows" in json && "columns" in json) {
    const { columns, rows } = json as { columns: string[]; rows: unknown[][] };
    const at = (name: string) => columns.indexOf(name);
    const [id, name, set, number, ill, layout, printings] = ["id", "name", "set", "number", "illustration_id", "layout", "printings"].map(at);
    return rows.map((r) => ({
      id: String(r[id!] ?? ""),
      name: String(r[name!] ?? ""),
      set: String(r[set!] ?? ""),
      number: String(r[number!] ?? ""),
      illustrationId: typeof r[ill!] === "string" ? (r[ill!] as string) : null,
      layout: String(r[layout!] ?? "normal"),
      printings: typeof r[printings!] === "number" ? (r[printings!] as number) : 1,
    }));
  }
  if (!Array.isArray(json)) throw new Error("The artwork index is not in a form the scanner reads");
  return json.map((r: Record<string, unknown>) => ({
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    set: String(r.set ?? ""),
    number: String(r.collector_number ?? ""),
    illustrationId: typeof r.illustration_id === "string" ? r.illustration_id : null,
    layout: String(r.layout ?? "normal"),
    printings: typeof r.printing_count === "number" ? r.printing_count : 1,
  }));
}
