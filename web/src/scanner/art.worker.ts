/// <reference lib="webworker" />
// Runs the art recognizer off the main thread. The bundle files come from our server
// (/api/scan/bundle) and are kept in the Cache API, so the second scan starts without downloading.
// One WASM thread: Yama isn't cross-origin isolated, and phones gain little from more.

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { createRecognizer, parseArts, type BundleConstants, type OrtLike, type Recognizer } from "./recognizer";
import type { ArtWorkerReply, ArtWorkerRequest, BundleInfo } from "./artClient";

/** Also listed in public/sw.js, so the service worker's clean-up keeps it. */
const CACHE = "yama-scan-v1";

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

let recognizer: Recognizer | null = null;
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

async function load(info: BundleInfo, base: string) {
  const t0 = performance.now();
  const urls = { detector: info.files.detector, embed: info.files.embed, search: info.files.search, arts: info.files.arts, runtime: wasmUrl };
  // Drop files of older bundles.
  const cache = await caches.open(CACHE).catch(() => null);
  if (cache) {
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/scan-bundle/") && !path.startsWith(`/scan-bundle/${info.version}/`)) await cache.delete(req);
    }
  }
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
    const size = key === "runtime" ? 15_000_000 : info.bytes?.[key] ?? 0;
    return file(url, size, (l, t) => {
      progress.set(key, [l, t]);
      report();
    });
  };
  const [runtime, detector, embed, search, arts] = await Promise.all([get("runtime"), get("detector"), get("embed"), get("search"), get("arts")]);
  ort.env.wasm.wasmBinary = runtime;
  const gallery = parseArts(JSON.parse(new TextDecoder().decode(arts)));
  recognizer = await createRecognizer(ort as unknown as OrtLike, { detector, embed, search }, info.constants as unknown as BundleConstants, gallery);
  reply({ type: "ready", ms: performance.now() - t0, arts: gallery.length });
}

self.onmessage = async (event: MessageEvent<ArtWorkerRequest>) => {
  const m = event.data;
  try {
    if (m.type === "load") await load(m.info, m.base);
    else if (m.type === "reset") recognizer?.reset();
    else if (m.type === "identify") {
      if (!recognizer) throw new Error("The card recognizer isn't loaded");
      const result = await recognizer.identify({ width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) });
      reply({ type: "result", id: m.id, result, buffer: m.buffer }, [m.buffer]);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (m.type === "identify") reply({ type: "failed", id: m.id, message, buffer: m.buffer }, [m.buffer]);
    else reply({ type: "error", message });
  }
};
