/// <reference lib="webworker" />
// Runs the art recognizer off the main thread. The bundle files come from our server
// (/api/scan/bundle) and are kept in the Cache API, so the second scan starts without downloading.
// One WASM thread: Yama isn't cross-origin isolated, and phones gain little from more.

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { createRecognizer, parseArts, parseSupplement, poolIndices, type Art, type BundleConstants, type OrtLike, type Recognizer, type Supplement } from "./recognizer";
import type { ArtWorkerReply, ArtWorkerRequest, BundleInfo, EmbedFile } from "./artClient";
import { isStale, namedPaths } from "./bundleCache";

/** Also listed in public/sw.js, so the service worker's clean-up keeps it. */
const CACHE = "yama-scan-v1";

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

let recognizer: Recognizer | null = null;
let arts: Art[] = [];
const reply = (m: ArtWorkerReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** A file from the cache, or downloaded (with progress) and cached. */
async function file(url: string, size: number, onBytes: (n: number, total: number) => void): Promise<Uint8Array> {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onBytes(bytes.length, bytes.length);
    return bytes;
  }
  // The Android app fetches from the server's origin with no cookie (api.ts, FETCH_CREDENTIALS).
  const res = await fetch(url, { credentials: new URL(url).origin === self.location.origin ? "include" : "omit" });
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${url.split("/").pop()} (${res.status})`);
  // Content-Length is the zipped size when the server compresses; the manifest's is the real one.
  const total = size || Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(got, Math.max(total, got));
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  await cache?.put(url, new Response(bytes, { headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" } })).catch(() => undefined);
  return bytes;
}

async function load(info: BundleInfo, base: string, embedFile: EmbedFile) {
  const t0 = performance.now();
  const urls = { detector: info.files.detector, embed: embedFile.url, search: info.files.search, arts: info.files.arts, runtime: wasmUrl };
  const supplementUrl = info.files.supplement ?? null;
  const progress = new Map<string, [number, number]>();
  let lastReport = 0;
  const report = () => {
    const now = performance.now();
    if (now - lastReport < 150) return;
    lastReport = now;
    let loaded = 0;
    let total = 0;
    for (const [l, t] of progress.values()) {
      loaded += l;
      total += t;
    }
    reply({ type: "progress", loaded, total });
  };
  const get = (key: keyof typeof urls) => {
    const url = new URL(urls[key], key === "runtime" ? self.location.href : base || self.location.origin).href;
    // The WASM runtime's size isn't in the bundle info; about 15 MB.
    const size = key === "runtime" ? 15_000_000 : key === "embed" ? embedFile.bytes : (info.bytes?.[key] ?? 0);
    return file(url, size, (l, t) => {
      progress.set(key, [l, t]);
      report();
    });
  };
  // Artworks newer than the bundle, embedded by the server. Optional: without it the scanner
  // still knows every artwork in the bundle.
  const extra = supplementUrl
    ? file(new URL(supplementUrl, base || self.location.origin).href, info.bytes?.supplement ?? 0, (l, t) => {
        progress.set("supplement", [l, t]);
        report();
      }).catch((e) => {
        console.warn("The scanner's artwork supplement didn't load", e);
        return null;
      })
    : Promise.resolve(null);
  const [runtime, detector, embed, search, artsFile, supplementFile] = await Promise.all([get("runtime"), get("detector"), get("embed"), get("search"), get("arts"), extra]);
  ort.env.wasm.wasmBinary = runtime;
  const gallery = parseArts(JSON.parse(new TextDecoder().decode(artsFile)));
  let supplement: Supplement | null = null;
  if (supplementFile) {
    try {
      supplement = parseSupplement(JSON.parse(new TextDecoder().decode(supplementFile)), info.version);
    } catch (e) {
      console.warn("The scanner's artwork supplement can't be read", e);
    }
  }
  recognizer = await createRecognizer(ort as unknown as OrtLike, { detector, embed, search }, info.constants as unknown as BundleConstants, gallery, supplement);
  // Gallery order, then the supplement's rows: the indices the recognizer reports.
  arts = supplement ? gallery.concat(supplement.arts) : gallery;
  // Only now that this bundle's files are here (and cached) and the recognizer runs, drop the ones
  // the server no longer names: older bundles, a replaced embed graph, other supplements. Dropping
  // them first, a cut-short download could leave the phone with neither embed graph offline.
  const cache = await caches.open(CACHE).catch(() => null);
  if (cache) {
    const named = namedPaths(info, base || self.location.origin);
    for (const req of await cache.keys()) {
      if (isStale(req.url, named)) await cache.delete(req);
    }
  }
  base_ = base;
  reply({ type: "ready", ms: performance.now() - t0, arts: arts.length });
}

/** The server's origin the bundle files are fetched from (set by `load`). */
let base_ = "";

/** Swap the art match's query model for another (Scan settings): the rest stays loaded. */
async function useEmbed(embedFile: EmbedFile) {
  if (!recognizer) throw new Error("The card recognizer isn't loaded");
  const graph = await file(new URL(embedFile.url, base_ || self.location.origin).href, embedFile.bytes, () => undefined);
  await recognizer.setEmbed(graph);
}

self.onmessage = async (event: MessageEvent<ArtWorkerRequest>) => {
  const m = event.data;
  try {
    if (m.type === "load") await load(m.info, m.base, m.embed);
    else if (m.type === "embed") {
      try {
        await useEmbed(m.embed);
        reply({ type: "embedded", id: m.id, error: null });
      } catch (e) {
        reply({ type: "embedded", id: m.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    else if (m.type === "reset") recognizer?.reset();
    else if (m.type === "pool") {
      if (!recognizer) throw new Error("The card recognizer isn't loaded");
      const indices = m.keys ? poolIndices(arts, m.keys) : null;
      const ok = recognizer.setPool(indices);
      reply({ type: "pooled", id: m.id, arts: ok ? (indices?.length ?? 0) : -1 });
    }
    else if (m.type === "identify") {
      if (!recognizer) throw new Error("The card recognizer isn't loaded");
      const result = await recognizer.identify({ width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) });
      reply({ type: "result", id: m.id, result, buffer: m.buffer }, [m.buffer]);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (m.type === "identify") reply({ type: "failed", id: m.id, message, buffer: m.buffer }, [m.buffer]);
    else if (m.type === "pool") reply({ type: "pooled", id: m.id, arts: -1 });
    else reply({ type: "error", message });
  }
};
