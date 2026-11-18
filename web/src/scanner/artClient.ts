// Main-thread side of the art recognizer: starts the worker, loads the bundle the server names,
// and hands it frames one at a time.

import { api, API_BASE } from "../api";
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
}

export type ArtWorkerRequest =
  | { type: "load"; info: BundleInfo; base: string }
  | { type: "reset" }
  | { type: "pool"; id: number; keys: PoolKeys | null }
  | { type: "identify"; id: number; width: number; height: number; buffer: ArrayBuffer };

export type ArtWorkerReply =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; ms: number; arts: number }
  | { type: "error"; message: string }
  | { type: "pooled"; id: number; arts: number }
  | { type: "result"; id: number; result: Recognition; buffer: ArrayBuffer }
  | { type: "failed"; id: number; message: string; buffer: ArrayBuffer };

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
  reset(): void;
  /**
   * Match only these artworks as well (the set lock), into `Recognition.pool`; null stops. Resolves
   * to how many of the bundle's artworks they are, or -1 when this bundle can't be searched by part.
   */
  setPool(keys: PoolKeys | null): Promise<number>;
  dispose(): void;
  /**
   * The bundle version and embed graph this recognizer runs (`embedIdentity`): the bundle's
   * `embed.onnx` or Yama's query model. Kept photos and diagnostics carry it, so the server
   * records the model and bundle the phone really ran (a tab open across a change included).
   */
  readonly embed: string;
}

/** What kept photos and diagnostics say ran when the scanner read text only, with no art model. */
export const NO_ART_MODEL = "none";

/** `<bundle version>/<embed file>`: the art model a recognizer loaded from this bundle info. */
export const embedIdentity = (info: Pick<BundleInfo, "version" | "files">): string => `${info.version}/${info.files.embed.split("/").pop() ?? ""}`;

export type LoadState = { kind: "downloading"; loaded: number; total: number } | { kind: "preparing" };

/** The last ready bundle's info, kept on the device: the API isn't cached, the bundle files are. */
const INFO_KEY = "yama-scan-bundle";

/**
 * The server's bundle info, or when it can't be reached (offline), the last one that loaded here
 * (kept once the recognizer is ready, so its files are all in the cache; a cut-short download of
 * a new embed graph, say, leaves the previous info and files for offline use).
 */
async function bundleInfo(): Promise<BundleInfo | null> {
  try {
    return await api<BundleInfo>("/api/scan/bundle");
  } catch (e) {
    const kept = localStorage.getItem(INFO_KEY);
    if (!kept) throw e;
    return JSON.parse(kept) as BundleInfo;
  }
}

/**
 * Start the recognizer. Resolves null when the server doesn't have the bundle yet (it starts
 * downloading it; the scanner reads text meanwhile). Rejects on a real failure.
 */
export async function loadArtRecognizer(onState?: (s: LoadState) => void): Promise<ArtRecognizer | null> {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return null;
  const info = await bundleInfo();
  if (!info?.ready || !info.constants) return null;
  const worker = new Worker(new URL("./art.worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (r: Recognition) => void; reject: (e: Error) => void }>();
  const pooling = new Map<number, (arts: number) => void>();
  let nextId = 1;
  let disposed = false;

  await new Promise<void>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ArtWorkerReply>) => {
      const m = e.data;
      if (m.type === "progress") onState?.(m.loaded >= m.total ? { kind: "preparing" } : { kind: "downloading", loaded: m.loaded, total: m.total });
      else if (m.type === "ready") resolve();
      else if (m.type === "error") reject(new Error(m.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || "The card recognizer stopped"));
    worker.postMessage({ type: "load", info, base: API_BASE || location.origin } satisfies ArtWorkerRequest);
  }).catch((e: unknown) => {
    worker.terminate();
    throw e;
  });
  try {
    localStorage.setItem(INFO_KEY, JSON.stringify(info));
  } catch {
    /* storage off: offline opens need the server */
  }

  worker.onmessage = (e: MessageEvent<ArtWorkerReply>) => {
    const m = e.data;
    if (m.type === "pooled") {
      pooling.get(m.id)?.(m.arts);
      pooling.delete(m.id);
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
  };

  return {
    embed: embedIdentity(info),
    identify(image) {
      if (disposed) return Promise.reject(new Error("The scanner is closed"));
      const id = nextId++;
      const buffer = image.data.buffer as ArrayBuffer;
      return new Promise<Recognition>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "identify", id, width: image.width, height: image.height, buffer } satisfies ArtWorkerRequest, [buffer]);
      });
    },
    reset() {
      if (!disposed) worker.postMessage({ type: "reset" } satisfies ArtWorkerRequest);
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
    },
  };
}
