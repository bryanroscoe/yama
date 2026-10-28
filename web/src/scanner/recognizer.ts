// Card recognition by artwork: find the card anywhere in a frame, then match its art against
// one vector per Scryfall illustration. Runs the three graphs of a ManaVault/oracle scanner
// bundle (MPL-2.0 weights, served by our server: see server/src/scan_bundle.rs). The glue is
// our own; docs/scanner.md has the measurements and the licence notes.
//
//   frame ─▶ detector on the middle square ─▶ detector again on a window around the card
//         ─▶ embed (the graph warps the card itself) ─▶ search ─▶ top 5 illustrations
//
// The onnxruntime namespace is passed in, so the web worker and the Node eval share this file.

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
  timings: { detectMs: number; embedMs: number; totalMs: number };
}

export interface Recognizer {
  identify(frame: RgbaImage): Promise<Recognition>;
  /** Forget the tracked card (after it was accepted, say). */
  reset(): void;
}

/** The parts of onnxruntime-web this uses. */
export interface OrtLike {
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<Session> };
  Tensor: new (type: "uint8" | "float32", data: Uint8Array | Float32Array, dims: readonly number[]) => unknown;
}
interface Session {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
}

/** Detector votes below this saw nothing card-like (empty tables vote under 0.2, cards over 0.9). */
const EMPTY = 0.25;
/** A card is in view at this vote and at least this short side in frame pixels. */
const IN_VIEW = 0.5;
const MIN_SHORT = 60;
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

const shortSide = (q: Quad) => Math.min(...q.map((p, i) => Math.hypot(q[(i + 1) % 4]![0] - p[0], q[(i + 1) % 4]![1] - p[1])));

export async function createRecognizer(ort: OrtLike, graphs: { detector: Uint8Array; embed: Uint8Array; search: Uint8Array }, constants: BundleConstants, arts: Art[]): Promise<Recognizer> {
  const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  // One at a time: three parallel compiles peak higher in memory, which phones notice.
  const detector = await ort.InferenceSession.create(graphs.detector, options);
  const embed = await ort.InferenceSession.create(graphs.embed, options);
  const search = await ort.InferenceSession.create(graphs.search, options);
  const size = constants.det_input;
  const now = () => performance.now();

  const detect = async (frame: RgbaImage, w: Window): Promise<Detection> => {
    const out = await detector.run({ window: new ort.Tensor("uint8", sampleWindow(frame, w, size), [size, size, 4]) });
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

  const match = async (frame: RgbaImage, quad: Quad): Promise<ArtMatch[]> => {
    const scene = new ort.Tensor("uint8", new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), [frame.height, frame.width, 4]);
    const vectors = await embed.run({ scene, quad: new ort.Tensor("float32", Float32Array.from(quad.flat()), [4, 2]) });
    const ranked = await search.run({ embeddings: Object.values(vectors)[0] });
    const indices = ranked.indices!.data as BigInt64Array | Int32Array;
    const scores = ranked.scores!.data as Float32Array;
    const out: ArtMatch[] = [];
    for (let i = 0; i < indices.length; i += 1) {
      const index = Number(indices[i]);
      const art = arts[index];
      // A masked or padded row scores below -1; real scores are cosines.
      if (art && scores[i]! >= -1) out.push({ ...art, index, score: scores[i]! });
    }
    return out;
  };

  let tracked: Window | null = null;
  let trackedFor = 0;

  const identify = async (frame: RgbaImage): Promise<Recognition> => {
    const t0 = now();
    let fine: Detection | null = null;
    // While the card stays put, one pass on last frame's card window is enough.
    if (tracked && trackedFor < RETRACK_EVERY) {
      const d = await detect(frame, tracked);
      const next = around(d);
      const moved = Math.hypot(next.cx - tracked.cx, next.cy - tracked.cy);
      const ratio = next.side / tracked.side;
      if (d.vote >= EMPTY && moved <= tracked.side * 0.1 && ratio >= 0.8 && ratio <= 1.25) fine = d;
    }
    const wasTracking = !!fine;
    if (!fine) {
      const centre = { cx: frame.width / 2, cy: frame.height / 2 };
      let coarse = await detect(frame, { ...centre, side: constants.scene });
      // A card held close can overflow the middle square; look at the whole frame too.
      const whole = Math.max(frame.width, frame.height);
      if (coarse.vote < EMPTY && whole > constants.scene * 1.1) coarse = await detect(frame, { ...centre, side: whole });
      fine = coarse.vote >= EMPTY ? await detect(frame, around(coarse)) : coarse;
    }
    const t1 = now();
    const inView = fine.vote >= IN_VIEW && shortSide(fine.quad) >= MIN_SHORT;
    tracked = inView ? around(fine) : null;
    trackedFor = inView && wasTracking ? trackedFor + 1 : 0;
    const matches = inView ? await match(frame, fine.quad) : [];
    const t2 = now();
    return { quad: inView ? fine.quad : null, upright: fine.vote, matches, timings: { detectMs: t1 - t0, embedMs: t2 - t1, totalMs: t2 - t0 } };
  };

  // Each graph's first run sets up its kernels; pay that before the first real frame.
  const blank: RgbaImage = { width: constants.scene, height: constants.scene, data: new Uint8ClampedArray(constants.scene ** 2 * 4).fill(255) };
  await identify(blank);
  const h = constants.scene / 2;
  await match(blank, [[h - 125, h - 175], [h + 125, h - 175], [h + 125, h + 175], [h - 125, h + 175]]);
  tracked = null;

  return {
    identify,
    reset() {
      tracked = null;
      trackedFor = 0;
    },
  };
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
