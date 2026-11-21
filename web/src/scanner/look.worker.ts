/// <reference lib="webworker" />
// The printing look (look.ts) in a worker of its own, beside the art worker, so comparing a card
// with its printings never holds up the camera's frames: it embeds the card from the frames the art
// worker kept, then each candidate printing's Scryfall picture (fetched with CORS, decoded with
// createImageBitmap), a few at a time, and reports each score as it comes. A printing's embedding
// is kept per model in memory and in the scanner's Cache API under /look-cache/<model>/, which the
// bundle clean-up (bundleCache.ts) leaves alone. One WASM thread, as for the art worker.

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { cornersOf, embedLook, meanEmbedding, packLook, scoreCandidates, unpackLook, type LookCandidate, type LookDone, type LookEmbedding, type LookSession, type LookTensor, type LookWorkerReply, type LookWorkerRequest } from "./look";
import { cachedFile, SCAN_CACHE } from "./scanCache";

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

const reply = (m: LookWorkerReply) => (self as DedicatedWorkerGlobalScope).postMessage(m);
const Tensor = ort.Tensor as unknown as LookTensor;
/** How many printings a look compares at once: fetched and decoded side by side, embedded one at a time. */
const AT_ONCE = 3;
const LOOK_CACHE = "/look-cache/";

let model: { session: LookSession; key: string } | null = null;
let loading: Promise<void> | null = null;
const runs = new Map<number, AbortController>();
const keys = new Map<string, LookEmbedding>();

/** Load the look model, and drop printings embedded by another. */
async function load(url: string, bytes: number) {
  const key = url.split("/").pop()!.replace(/\.onnx$/, "");
  if (model?.key === key) return;
  ort.env.wasm.wasmBinary ??= await cachedFile(new URL(wasmUrl, self.location.href).href, 15_000_000, () => undefined);
  const graph = await cachedFile(url, bytes, () => undefined);
  const session = (await ort.InferenceSession.create(graph, { executionProviders: ["wasm"], graphOptimizationLevel: "all" })) as unknown as LookSession;
  model = { session, key };
  for (const k of keys.keys()) if (!k.startsWith(`${key}|`)) keys.delete(k);
  const cache = await caches.open(SCAN_CACHE).catch(() => null);
  if (!cache) return;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith(LOOK_CACHE) && !path.startsWith(`${LOOK_CACHE}${key}/`)) await cache.delete(req);
  }
}

type Times = Pick<LookDone, "cached" | "fetchMs" | "decodeMs" | "embedMs">;

/** A printing's picture, embedded: from memory, the cache, or fetched from Scryfall. */
async function key(m: { session: LookSession; key: string }, c: LookCandidate, times: Times, signal?: AbortSignal): Promise<LookEmbedding> {
  const memo = `${m.key}|${c.url}`;
  const hit = keys.get(memo);
  if (hit) {
    times.cached += 1;
    return hit;
  }
  const cacheUrl = new URL(`${LOOK_CACHE}${m.key}/${encodeURIComponent(c.url)}`, self.location.origin).href;
  const cache = await caches.open(SCAN_CACHE).catch(() => null);
  const kept = await cache?.match(cacheUrl);
  const unpacked = kept ? unpackLook(new Float32Array(await kept.arrayBuffer())) : null;
  if (unpacked) {
    keys.set(memo, unpacked);
    times.cached += 1;
    return unpacked;
  }
  // cards.scryfall.io answers with Access-Control-Allow-Origin: *, so its pixels can be read.
  const t0 = performance.now();
  const res = await fetch(c.url, { mode: "cors", credentials: "omit", signal });
  if (!res.ok) throw new Error(`Couldn't fetch ${c.url} (${res.status})`);
  const blob = await res.blob();
  const t1 = performance.now();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const t2 = performance.now();
  const e = await embedLook(m.session, Tensor, { width: pixels.width, height: pixels.height, data: pixels.data }, cornersOf(pixels.width, pixels.height));
  times.fetchMs += t1 - t0;
  times.decodeMs += t2 - t1;
  times.embedMs += performance.now() - t2;
  keys.set(memo, e);
  await cache?.put(cacheUrl, new Response(packLook(e).buffer as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
  return e;
}

async function look(id: number, frames: Extract<LookWorkerRequest, { type: "look" }>["frames"], candidates: LookCandidate[]) {
  const t0 = performance.now();
  const stop = new AbortController();
  runs.set(id, stop);
  const times: Times = { cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0 };
  const base = { frames: frames.length, queryMs: 0, scored: 0, ...times };
  try {
    if (loading) await loading;
    const m = model;
    if (!m) throw new Error("No look model is loaded");
    if (frames.length === 0) throw new Error("No frame of this card is kept to compare");
    const seen: LookEmbedding[] = [];
    for (const f of frames) {
      if (stop.signal.aborted) break;
      seen.push(await embedLook(m.session, Tensor, { width: f.width, height: f.height, data: new Uint8ClampedArray(f.buffer) }, f.quad));
    }
    const query = meanEmbedding(seen);
    if (!query) throw new Error("The look was stopped");
    const queryMs = performance.now() - t0;
    const scored = await scoreCandidates(query, candidates, (c, signal) => key(m, c, times, signal), (candidate, score) => reply({ type: "score", id, candidate, score }), {
      concurrency: AT_ONCE,
      signal: stop.signal,
    });
    reply({ type: "done", id, error: null, model: m.key, frames: frames.length, queryMs, scored, ...times, ms: performance.now() - t0 });
  } catch (e) {
    reply({ type: "done", id, error: e instanceof Error ? e.message : String(e), model: model?.key ?? "", ...base, ...times, ms: performance.now() - t0 });
  } finally {
    runs.delete(id);
  }
}

self.onmessage = async (event: MessageEvent<LookWorkerRequest>) => {
  const m = event.data;
  if (m.type === "model") {
    const now = load(m.url, m.bytes);
    const mine = now.catch(() => undefined);
    loading = mine;
    try {
      await now;
      reply({ type: "ready", id: m.id, error: null });
    } catch (e) {
      model = null;
      reply({ type: "ready", id: m.id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (loading === mine) loading = null;
    }
  } else if (m.type === "look") void look(m.id, m.frames, m.candidates);
  else if (m.type === "stop") runs.get(m.id)?.abort();
};
