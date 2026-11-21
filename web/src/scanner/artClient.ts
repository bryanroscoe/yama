// Main-thread side of the art recognizer: starts the worker, loads the bundle the server names,
// and hands it frames one at a time.

import { api, API_BASE } from "../api";
import type { LookCandidate, LookDone, LookWorkerReply, LookWorkerRequest, WireFrame } from "./look";
import type { ModelOption, ModelsInfo } from "./models";
import type { Recognition } from "./recognizer";
import type { RgbaImage } from "./types";

export interface BundleInfo {
  version: string;
  ready: boolean;
  error: string | null;
  /** `supplement`: artworks the bundle doesn't know, embedded by Yama (server/src/scan_art.rs); null or absent when there are none. */
  files: { detector: string; embed: string; search: string; arts: string; supplement?: string | null };
  /** Unzipped sizes, for progress. */
  bytes: { detector: number; embed: number; search: number; arts: number; supplement?: number };
  constants: Record<string, unknown> | null;
  /** What each of the scanner's slots can run (models.ts); absent from servers before 20 Nov 2026. */
  models?: Partial<ModelsInfo> | null;
}

/** An art query model's file, as the worker loads it. */
export interface EmbedFile {
  url: string;
  bytes: number;
}

export type ArtWorkerRequest =
  | { type: "load"; info: BundleInfo; base: string; embed: EmbedFile; detector: EmbedFile }
  | { type: "embed"; id: number; embed: EmbedFile }
  /** Keep the last few frames with a card in them, for the printing look (look.ts), or stop. */
  | { type: "keep-frames"; on: boolean }
  /** Copies of the kept frames whose best match was artwork `index`. */
  | { type: "frames"; id: number; index: number }
  /** `frames`: also forget the frames kept for the printing look (a photo is another view). */
  | { type: "reset"; frames?: boolean }
  | { type: "detector"; id: number; file: EmbedFile }
  | { type: "pool"; id: number; keys: PoolKeys | null }
  | { type: "identify"; id: number; width: number; height: number; buffer: ArrayBuffer };

export type ArtWorkerReply =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; ms: number; arts: number }
  | { type: "error"; message: string }
  | { type: "pooled"; id: number; arts: number }
  | { type: "embedded"; id: number; error: string | null }
  | { type: "frames"; id: number; frames: WireFrame[] }
  | { type: "result"; id: number; result: Recognition; buffer: ArrayBuffer }
  | { type: "failed"; id: number; message: string; buffer: ArrayBuffer };

export type { LookDone } from "./look";

/** The short side of the frames the recognizer is given. The bundle's detector looks at 640 px. */
export const RECOGNIZER_SHORT_SIDE = 640;

/** What the set lock matches: the artworks of these printings. */
export interface PoolKeys {
  illustrations: string[];
  /** Scryfall IDs, for printings without illustration data. */
  ids: string[];
}

export interface ArtRecognizer {
  /** Takes ownership of `image.data`'s buffer. */
  identify(image: RgbaImage): Promise<Recognition>;
  /** Forget the card being tracked (between photos, say). */
  reset(opts?: { frames?: boolean }): void;
  /**
   * Match only these artworks as well (the set lock), into `Recognition.pool`; null stops. Resolves
   * to how many of the bundle's artworks they are, or -1 when this bundle can't be searched by part.
   */
  setPool(keys: PoolKeys | null): Promise<number>;
  dispose(): void;
  /**
   * The bundle version and embed graph this recognizer runs (`embedIdentity`): the bundle's
   * `embed.onnx` or one of Yama's query models. Kept photos and diagnostics carry it, so the server
   * records the model and bundle the phone really ran (a tab open across a change included).
   */
  readonly embed: string;
  /** The art slot's option it runs (models.ts), for records and Scan settings. */
  readonly art: string;
  /**
   * Run this art model from now on, without reloading the rest (Scan settings). Frames already
   * being read finish with the one before. Rejects, keeping the one before, if it can't be loaded.
   */
  useArt(option: ModelOption): Promise<void>;
  /** The look slot's option it runs ("off" for none). */
  readonly look: string;
  /** Load this look model (null: none). Rejects, keeping none, if it can't be loaded. */
  useLook(option: ModelOption | null): Promise<void>;
  /**
   * Compare these printings' pictures with the last few frames whose best match was artwork
   * `index` (the card found), reporting each score as it comes; stops with `signal`. Rejects when
   * no look model is loaded or no frame of the card is kept.
   */
  lookAt(index: number, candidates: LookCandidate[], onScore: (id: string, score: number) => void, signal?: AbortSignal): Promise<LookDone>;
  /** The card finder (detector slot) it runs, by option id. */
  readonly detector: string;
  /** Find cards with this card finder from now on, as useArt does for the art model. */
  useDetector(option: ModelOption): Promise<void>;
}

/** What kept photos and diagnostics say ran when the scanner read text only, with no art model. */
export const NO_ART_MODEL = "none";

/** `<bundle version>/<embed file>`: the art model a recognizer loaded from this bundle info (its `files.embed`, or `file`). */
export const embedIdentity = (info: Pick<BundleInfo, "version" | "files">, file: string = info.files.embed): string => `${info.version}/${file.split("/").pop() ?? ""}`;

/**
 * The art option a bundle info's `files.embed` is: the listed option with that file, else (servers
 * before `models`) "bundle" for the bundle's own, or the file's name.
 */
export const defaultArtId = (info: Pick<BundleInfo, "files" | "models">): string => {
  const listed = info.models?.art?.options.find((o) => o.file === info.files.embed);
  if (listed) return listed.id;
  const name = info.files.embed.split("/").pop() ?? "";
  return name === "embed.onnx" ? "bundle" : name.replace(/\.onnx$/, "");
};

/** The detector option a bundle info's `files.detector` is: the listed option with that file, else the bundle's. */
export const defaultDetectorId = (info: Pick<BundleInfo, "files" | "models">): string =>
  info.models?.detector?.options.find((o) => o.file === info.files.detector)?.id ?? "bundle-detector";

export type LoadState = { kind: "downloading"; loaded: number; total: number } | { kind: "preparing" };

/** The last ready bundle's info, kept on the device: the API isn't cached, the bundle files are. */
const INFO_KEY = "yama-scan-bundle";

/**
 * The server's bundle info, or when it can't be reached (offline), the last one that loaded here
 * (kept once the recognizer is ready, so its files are all in the cache; a cut-short download of
 * a new embed graph, say, leaves the previous info and files for offline use).
 */
export async function scanBundleInfo(): Promise<BundleInfo | null> {
  try {
    // can=cuts: this build feeds an art model's `cuts` input (recognizer.ts, the embed cascade), so the
    // server lists models that need it.
    return await api<BundleInfo>("/api/scan/bundle?can=cuts");
  } catch (e) {
    const kept = localStorage.getItem(INFO_KEY);
    if (!kept) throw e;
    return JSON.parse(kept) as BundleInfo;
  }
}

/** How long a load waits for another tab's before going ahead without the lock. */
const LOAD_LOCK_WAIT_MS = 60_000;

/**
 * Run `load` holding a lock shared by this browser's tabs (the Web Locks API), waiting at most
 * `wait` ms for another tab's load; without the API, or after that, it runs anyway.
 */
export async function oneLoadAtATime<T>(load: () => Promise<T>, wait = LOAD_LOCK_WAIT_MS): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return load();
  const gaveUp = new AbortController();
  const timer = setTimeout(() => gaveUp.abort(), wait);
  let started = false;
  try {
    return await locks.request(INFO_KEY, { signal: gaveUp.signal }, () => {
      started = true;
      clearTimeout(timer);
      return load();
    });
  } catch (e) {
    // Gave up waiting (the lock never came): load anyway. A failure of the load itself stands.
    if (!started) return load();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the recognizer with `art` (the art slot's option to run, models.ts; the bundle info's
 * `files.embed` when not given), from `info` (fetched when not given). Resolves null when the
 * server doesn't have the bundle yet (it starts downloading it; the scanner reads text meanwhile).
 * Rejects on a real failure. A chosen art model that won't load (not cached, opening offline) gives
 * way to the bundle info's own embed graph.
 */
export async function loadArtRecognizer(onState?: (s: LoadState) => void, opts: { info?: BundleInfo | null; art?: ModelOption | null; detector?: ModelOption | null } = {}): Promise<ArtRecognizer | null> {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return null;
  const info = opts.info !== undefined ? opts.info : await scanBundleInfo();
  if (!info?.ready || !info.constants) return null;
  const fallback = { id: defaultArtId(info), file: info.files.embed, bytes: info.bytes.embed };
  const art = opts.art?.file ? { id: opts.art.id, file: opts.art.file, bytes: opts.art.bytes ?? 0 } : fallback;
  const bundleFinder = { id: defaultDetectorId(info), file: info.files.detector, bytes: info.bytes.detector };
  const finder = opts.detector?.file ? { id: opts.detector.id, file: opts.detector.file, bytes: opts.detector.bytes ?? 0 } : bundleFinder;
  try {
    return await startRecognizer(info, art, finder, onState);
  } catch (e) {
    if (art.file === fallback.file && finder.file === bundleFinder.file) throw e;
    console.warn(`The models chosen (${art.id}, ${finder.id}) didn't load; running the defaults`, e);
    return startRecognizer(info, fallback, bundleFinder, onState);
  }
}

async function startRecognizer(info: BundleInfo, art: { id: string; file: string; bytes: number }, detector: { id: string; file: string; bytes: number }, onState?: (s: LoadState) => void): Promise<ArtRecognizer> {
  const worker = new Worker(new URL("./art.worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (r: Recognition) => void; reject: (e: Error) => void }>();
  const pooling = new Map<number, (arts: number) => void>();
  const embedding = new Map<number, (error: string | null) => void>();
  const framing = new Map<number, (frames: WireFrame[]) => void>();
  // The printing look's own worker (look.worker.ts), started when a look model is chosen.
  let lookWorker: Worker | null = null;
  const lookLoads = new Map<number, (error: string | null) => void>();
  const looks = new Map<number, { onScore: (id: string, score: number) => void; done: (r: LookDone | null, error: string | null) => void }>();
  let lookNow = "off";
  let lookSwitching: Promise<unknown> = Promise.resolve();
  const lookStopped = (error: string) => {
    for (const p of lookLoads.values()) p(error);
    lookLoads.clear();
    for (const l of looks.values()) l.done(null, error);
    looks.clear();
  };
  const startLookWorker = (): Worker => {
    if (lookWorker) return lookWorker;
    const w = new Worker(new URL("./look.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<LookWorkerReply>) => {
      const m = e.data;
      if (m.type === "ready") {
        lookLoads.get(m.id)?.(m.error);
        lookLoads.delete(m.id);
      } else if (m.type === "score") looks.get(m.id)?.onScore(m.candidate, m.score);
      else if (m.type === "done") {
        const { type: _type, id: _id, error, ...done } = m;
        looks.get(m.id)?.done(error ? null : done, error);
        looks.delete(m.id);
      }
    };
    w.onerror = (e) => {
      lookStopped(e.message || "The printing look stopped");
      w.terminate();
      if (lookWorker === w) lookWorker = null;
      lookNow = "off";
      worker.postMessage({ type: "keep-frames", on: false } satisfies ArtWorkerRequest);
    };
    lookWorker = w;
    return w;
  };
  let nextId = 1;
  let disposed = false;
  let now = art;
  /** The card finder running: the one chosen when it started (Scan settings may switch it later). */
  let finder = detector;
  /** Model switches (art and card finder), one after another, so the last one asked for is the one that runs. */
  let switching: Promise<unknown> = Promise.resolve();
  const base = API_BASE || location.origin;

  // The worker drops cached files this info doesn't name, then the info is kept for offline use:
  // one load at a time across this browser's tabs, so two tabs loading different bundle info (the
  // server just switched) can't each drop the files the other cached.
  await oneLoadAtATime(async () => {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ArtWorkerReply>) => {
        const m = e.data;
        if (m.type === "progress") onState?.(m.loaded >= m.total ? { kind: "preparing" } : { kind: "downloading", loaded: m.loaded, total: m.total });
        else if (m.type === "ready") resolve();
        else if (m.type === "error") reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || "The card recognizer stopped"));
      worker.postMessage({ type: "load", info, base, embed: { url: art.file, bytes: art.bytes }, detector: { url: detector.file, bytes: detector.bytes } } satisfies ArtWorkerRequest);
    }).catch((e: unknown) => {
      worker.terminate();
      throw e;
    });
    try {
      localStorage.setItem(INFO_KEY, JSON.stringify(info));
    } catch {
      /* storage off: offline opens need the server */
    }
  });

  worker.onmessage = (e: MessageEvent<ArtWorkerReply>) => {
    const m = e.data;
    if (m.type === "pooled") {
      pooling.get(m.id)?.(m.arts);
      pooling.delete(m.id);
      return;
    }
    if (m.type === "embedded") {
      embedding.get(m.id)?.(m.error);
      embedding.delete(m.id);
      return;
    }
    if (m.type === "frames") {
      framing.get(m.id)?.(m.frames);
      framing.delete(m.id);
      return;
    }
    if (m.type !== "result" && m.type !== "failed") return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === "result") p?.resolve(m.result);
    else p?.reject(new Error(m.message));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "The card recognizer stopped"));
    pending.clear();
    for (const p of embedding.values()) p(e.message || "The card recognizer stopped");
    embedding.clear();
    for (const p of framing.values()) p([]);
    framing.clear();
  };

  return {
    get embed() {
      return embedIdentity(info, now.file);
    },
    get art() {
      return now.id;
    },
    useArt(option) {
      if (disposed) return Promise.reject(new Error("The scanner is closed"));
      if (!option.file) return Promise.reject(new Error(`${option.label} has no model file`));
      const next = { id: option.id, file: option.file, bytes: option.bytes ?? 0 };
      const run = () => {
        if (disposed) return Promise.reject(new Error("The scanner is closed"));
        if (next.file === now.file) return Promise.resolve();
        const id = nextId++;
        return new Promise<void>((resolve, reject) => {
          embedding.set(id, (error) => {
            if (error) return reject(new Error(error));
            now = next;
            resolve();
          });
          worker.postMessage({ type: "embed", id, embed: { url: next.file, bytes: next.bytes } } satisfies ArtWorkerRequest);
        });
      };
      const done = switching.then(run, run);
      switching = done.catch(() => undefined);
      return done;
    },
    get look() {
      return lookNow;
    },
    useLook(option) {
      if (disposed) return Promise.reject(new Error("The scanner is closed"));
      const want = option?.file ? { id: option.id, file: option.file, bytes: option.bytes ?? 0 } : null;
      const run = () => {
        if (disposed) return Promise.reject(new Error("The scanner is closed"));
        if ((want?.id ?? "off") === lookNow) return Promise.resolve();
        if (!want) {
          // Off: the look's worker goes, and with it its model and the frames kept for it.
          worker.postMessage({ type: "keep-frames", on: false } satisfies ArtWorkerRequest);
          lookStopped("The printing look is off");
          lookWorker?.terminate();
          lookWorker = null;
          lookNow = "off";
          return Promise.resolve();
        }
        const w = startLookWorker();
        const id = nextId++;
        return new Promise<void>((resolve, reject) => {
          lookLoads.set(id, (error) => {
            if (error) {
              // No model: the worker and its runtime go (and any look on it ends), and nothing
              // keeps frames for it.
              lookNow = "off";
              for (const l of looks.values()) l.done(null, error);
              looks.clear();
              worker.postMessage({ type: "keep-frames", on: false } satisfies ArtWorkerRequest);
              w.terminate();
              if (lookWorker === w) lookWorker = null;
              return reject(new Error(error));
            }
            lookNow = want.id;
            // Frames are kept (copied in the art worker) only once there's a model to use them.
            worker.postMessage({ type: "keep-frames", on: true } satisfies ArtWorkerRequest);
            resolve();
          });
          w.postMessage({ type: "model", id, url: new URL(want.file, base).href, bytes: want.bytes } satisfies LookWorkerRequest);
        });
      };
      const done = lookSwitching.then(run, run);
      lookSwitching = done.catch(() => undefined);
      return done;
    },
    async lookAt(index, candidates, onScore, signal) {
      if (disposed) throw new Error("The scanner is closed");
      const w = lookWorker;
      if (!w) throw new Error("No look model is loaded");
      // The card's side: the frames the art worker kept of it, handed over to the look's worker.
      const fid = nextId++;
      const frames = await new Promise<WireFrame[]>((resolve) => {
        framing.set(fid, resolve);
        worker.postMessage({ type: "frames", id: fid, index } satisfies ArtWorkerRequest);
      });
      if (signal?.aborted) throw new Error("The look was stopped");
      if (lookWorker !== w) throw new Error("The printing look was switched");
      const id = nextId++;
      return new Promise<LookDone>((resolve, reject) => {
        looks.set(id, { onScore, done: (r, error) => (r ? resolve(r) : reject(new Error(error ?? "The look stopped"))) });
        signal?.addEventListener("abort", () => w.postMessage({ type: "stop", id } satisfies LookWorkerRequest), { once: true });
        w.postMessage({ type: "look", id, frames, candidates } satisfies LookWorkerRequest, frames.map((f) => f.buffer));
      });
    },
    get detector() {
      return finder.id;
    },
    useDetector(option) {
      if (disposed) return Promise.reject(new Error("The scanner is closed"));
      if (!option.file) return Promise.reject(new Error(`${option.label} has no model file`));
      const next = { id: option.id, file: option.file, bytes: option.bytes ?? 0 };
      const run = () => {
        if (disposed) return Promise.reject(new Error("The scanner is closed"));
        if (next.file === finder.file) return Promise.resolve();
        const id = nextId++;
        return new Promise<void>((resolve, reject) => {
          embedding.set(id, (error) => {
            if (error) return reject(new Error(error));
            finder = next;
            resolve();
          });
          worker.postMessage({ type: "detector", id, file: { url: next.file, bytes: next.bytes } } satisfies ArtWorkerRequest);
        });
      };
      const done = switching.then(run, run);
      switching = done.catch(() => undefined);
      return done;
    },
    identify(image) {
      if (disposed) return Promise.reject(new Error("The scanner is closed"));
      const id = nextId++;
      const buffer = image.data.buffer as ArrayBuffer;
      return new Promise<Recognition>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "identify", id, width: image.width, height: image.height, buffer } satisfies ArtWorkerRequest, [buffer]);
      });
    },
    reset(opts) {
      if (!disposed) worker.postMessage({ type: "reset", frames: opts?.frames } satisfies ArtWorkerRequest);
    },
    setPool(keys) {
      if (disposed) return Promise.resolve(-1);
      const id = nextId++;
      return new Promise<number>((resolve) => {
        pooling.set(id, resolve);
        worker.postMessage({ type: "pool", id, keys } satisfies ArtWorkerRequest);
      });
    },
    dispose() {
      disposed = true;
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("The scanner is closed"));
      pending.clear();
      for (const p of pooling.values()) p(-1);
      pooling.clear();
      for (const p of embedding.values()) p("The scanner is closed");
      embedding.clear();
      lookStopped("The scanner is closed");
      lookWorker?.terminate();
      lookWorker = null;
      for (const p of framing.values()) p([]);
      framing.clear();
    },
  };
}
