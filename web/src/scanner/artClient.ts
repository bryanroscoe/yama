// Main-thread side of the art recognizer: starts the worker, loads the bundle the server names,
// and hands it frames one at a time.

import { api, API_BASE } from "../api";
import type { Recognition } from "./recognizer";
import type { RgbaImage } from "./types";

export interface BundleInfo {
  version: string;
  ready: boolean;
  error: string | null;
  files: { detector: string; embed: string; search: string; arts: string };
  /** Unzipped sizes, for progress. */
  bytes: { detector: number; embed: number; search: number; arts: number };
  constants: Record<string, unknown> | null;
}

export type ArtWorkerRequest =
  | { type: "load"; info: BundleInfo; base: string }
  | { type: "reset" }
  | { type: "identify"; id: number; width: number; height: number; buffer: ArrayBuffer };

export type ArtWorkerReply =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; ms: number; arts: number }
  | { type: "error"; message: string }
  | { type: "result"; id: number; result: Recognition; buffer: ArrayBuffer }
  | { type: "failed"; id: number; message: string; buffer: ArrayBuffer };

/** The short side of the frames the recognizer is given. The bundle's detector looks at 640 px. */
export const RECOGNIZER_SHORT_SIDE = 640;

export interface ArtRecognizer {
  /** Takes ownership of `image.data`'s buffer. */
  identify(image: RgbaImage): Promise<Recognition>;
  /** Forget the card being tracked (between photos, say). */
  reset(): void;
  dispose(): void;
}

export type LoadState = { kind: "downloading"; loaded: number; total: number } | { kind: "preparing" };

/**
 * Start the recognizer. Resolves null when the server doesn't have the bundle yet (it starts
 * downloading it; the scanner reads text meanwhile). Rejects on a real failure.
 */
export async function loadArtRecognizer(onState?: (s: LoadState) => void): Promise<ArtRecognizer | null> {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return null;
  const info = await api<BundleInfo>("/api/scan/bundle");
  if (!info.ready || !info.constants) return null;
  const worker = new Worker(new URL("./art.worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (r: Recognition) => void; reject: (e: Error) => void }>();
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

  worker.onmessage = (e: MessageEvent<ArtWorkerReply>) => {
    const m = e.data;
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
    dispose() {
      disposed = true;
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("The scanner is closed"));
      pending.clear();
    },
  };
}
