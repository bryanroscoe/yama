/// <reference lib="webworker" />
// The printing look (look.ts) in a worker of its own, beside the art worker, so comparing a card
// with its printings never holds up the camera's frames: it embeds the card from the frames the art
// worker kept, then each candidate printing's Scryfall picture (fetched with CORS, decoded with
// createImageBitmap), a few at a time, and reports each score as it comes. A printing's embedding
// is kept per model in memory and in a Cache API of its own (LOOK_CACHE, listed in public/sw.js),
// capped, so the art worker's clean-up of the bundle's cache never has to read through them. One
// WASM thread, as for the art worker.

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { cornersOf, embedLook, meanEmbedding, packLook, scoreCandidates, unpackLook, type LookCandidate, type LookDone, type LookEmbedding, type LookSession, type LookTensor, type LookWorkerReply, type LookWorkerRequest } from "./look";
import { cachedFile } from "./scanCache";

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

const reply = (m: LookWorkerReply) => (self as DedicatedWorkerGlobalScope).postMessage(m);
const Tensor = ort.Tensor as unknown as LookTensor;
/** How many printings a look compares at once: fetched and decoded side by side, embedded one at a time. */
const AT_ONCE = 3;
/** The printings' embeddings, about 1 KB each. Also listed in public/sw.js, so its clean-up keeps it. */
const LOOK_CACHE = "yama-look-v1";
/** Where an embedding is kept: /look-cache/<model>/<picture URL>; and which model they're for. */
const LOOK_PATH = "/look-cache/";
const CURRENT = `${LOOK_PATH}current`;
/** At most this many printings kept, in the cache and in memory: the oldest go first. */
const KEEP_CACHED = 4000;
const KEEP_IN_MEMORY = 1500;
let putsSinceTrim = 0;

let model: { session: LookSession; key: string } | null = null;
let loading: Promise<void> | null = null;
const runs = new Map<number, AbortController>();
const keys = new Map<string, LookEmbedding>();

/** Load the look model, and drop printings embedded by another. */
async function load(url: string, bytes: number) {
  // Reading a printing's pixels in a worker takes these; without them the look stays off and the
  // list keeps its order (iOS before 16.4 has no OffscreenCanvas).
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") throw new Error("This browser can't read the printings' pictures in the background");
  const key = url.split("/").pop()!.replace(/\.onnx$/, "");
  if (model?.key === key) return;
  ort.env.wasm.wasmBinary ??= await cachedFile(new URL(wasmUrl, self.location.href).href, 15_000_000, () => undefined);
  const graph = await cachedFile(url, bytes, () => undefined);
  const session = (await ort.InferenceSession.create(graph, { executionProviders: ["wasm"], graphOptimizationLevel: "all" })) as unknown as LookSession;
  const old = model;
  model = { session, key };
  void old?.session.release?.().catch(() => undefined);
  for (const k of keys.keys()) if (!k.startsWith(`${key}|`)) keys.delete(k);
  const cache = await caches.open(LOOK_CACHE).catch(() => null);
  if (!cache) return;
  // Another model's embeddings go, once, when the model changes (not on every scanner open).
  const current = await (await cache.match(new URL(CURRENT, self.location.origin).href))?.text();
  if (current === key) return;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path !== CURRENT && !path.startsWith(`${LOOK_PATH}${key}/`)) await cache.delete(req);
  }
  await cache.put(new URL(CURRENT, self.location.origin).href, new Response(key)).catch(() => undefined);
}

/** The oldest embeddings beyond KEEP_CACHED go (the Cache API lists them oldest first). */
async function trim(cache: Cache) {
  const all = (await cache.keys()).filter((r) => new URL(r.url).pathname !== CURRENT);
  for (const req of all.slice(0, Math.max(0, all.length - KEEP_CACHED))) await cache.delete(req);
}

const remember = (memo: string, e: LookEmbedding) => {
  keys.set(memo, e);
  if (keys.size > KEEP_IN_MEMORY) keys.delete(keys.keys().next().value!);
};

type Times = Pick<LookDone, "cached" | "fetchMs" | "decodeMs" | "embedMs">;

/** A printing's picture, embedded: from memory, the cache, or fetched from Scryfall. */
async function key(m: { session: LookSession; key: string }, c: LookCandidate, times: Times, signal?: AbortSignal): Promise<LookEmbedding> {
  const memo = `${m.key}|${c.url}`;
  const hit = keys.get(memo);
  if (hit) {
    times.cached += 1;
    return hit;
  }
  const cacheUrl = new URL(`${LOOK_PATH}${m.key}/${encodeURIComponent(c.url)}`, self.location.origin).href;
  const cache = await caches.open(LOOK_CACHE).catch(() => null);
  const kept = await cache?.match(cacheUrl);
  const unpacked = kept ? unpackLook(new Float32Array(await kept.arrayBuffer())) : null;
  if (unpacked) {
    remember(memo, unpacked);
    times.cached += 1;
    return unpacked;
  }
  // cards.scryfall.io answers with Access-Control-Allow-Origin: *, so its pixels can be read.
  // "no-store": the service worker serves a picture it has, but doesn't keep these in the offline
  // image cache (public/sw.js), which a big scan would otherwise churn.
  const t0 = performance.now();
  const res = await fetch(c.url, { mode: "cors", credentials: "omit", cache: "no-store", signal });
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
  remember(memo, e);
  if (cache) {
    await cache.put(cacheUrl, new Response(packLook(e).buffer as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
    if (++putsSinceTrim >= 100) {
      putsSinceTrim = 0;
      await trim(cache).catch(() => undefined);
    }
  }
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
