/// <reference lib="webworker" />
// The printing look (look.ts) in a worker of its own, beside the art worker, so comparing a card
// with its printings never holds up the camera's frames: it embeds the card from the frames the art
// worker kept, then each candidate printing's Scryfall picture (fetched with CORS, decoded with
// createImageBitmap), a few at a time, and reports each score as it comes. A printing's embedding
// is kept per model in memory and in a Cache API of its own (LOOK_CACHE, listed in public/sw.js),
// capped, so the art worker's clean-up of the bundle's cache never has to read through them. One
// WASM thread, as for the art worker.
//
// Yama's server makes the same vectors (server/src/scan_look.rs): for the printings this device
// hasn't got, the worker asks artClient to ask the server ("need") while it embeds the card's side,
// waits for the answer a moment at most, and fetches from Scryfall only what the server hasn't got;
// an answer that comes later still stops the fetches it makes needless (look.ts, `serverOrOwn`).

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import {
  cornersOf,
  embedLook,
  meanEmbedding,
  packLook,
  scoreCandidates,
  SERVER_MAX_IDS,
  ServerAnswer,
  serverKeys,
  serverOrOwn,
  unpackLook,
  type LookCandidate,
  type LookDone,
  type LookEmbedding,
  type LookSession,
  type LookTensor,
  type LookWorkerReply,
  type LookWorkerRequest,
  type WireFrame,
} from "./look";
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
/**
 * How long after a look begins its printings wait for the server's answer at most before fetching
 * their own pictures: the card's side is embedded meanwhile, which takes about that long on a
 * phone; an answer that comes later still cuts the fetching short.
 */
const SERVER_WAIT_MS = 400;

let model: { session: LookSession; key: string } | null = null;
let loading: Promise<void> | null = null;
const runs = new Map<number, AbortController>();
const keys = new Map<string, LookEmbedding>();
/** Each look's wait for the server's answer, by look id: settled by a "keys" message, or empty when the look ends. */
const answers = new Map<number, (looks: Extract<LookWorkerRequest, { type: "keys" }>["looks"], ms: number | null) => void>();

/** Load the look model, and drop printings embedded by another (unless `keepCache`: the speed test). */
async function load(url: string, bytes: number, keepCache = false) {
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
  // A look already under way may still be running the old one: let it finish first.
  if (old) setTimeout(() => void old.session.release?.().catch(() => undefined), 10_000);
  for (const k of keys.keys()) if (!k.startsWith(`${key}|`)) keys.delete(k);
  if (keepCache) return;
  const cache = await caches.open(LOOK_CACHE).catch(() => null);
  if (!cache) return;
  // Another model's embeddings go, once, when the model changes (not on every scanner open).
  const current = await (await cache.match(new URL(CURRENT, self.location.origin).href))?.text();
  if (current === key) {
    // Kept within its cap across scanner sessions, not only in one that adds 100.
    await trim(cache).catch(() => undefined);
    return;
  }
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

type Times = Pick<LookDone, "cached" | "fetchMs" | "decodeMs" | "embedMs"> & { server: number };

const cacheUrlOf = (m: { key: string }, c: LookCandidate) => new URL(`${LOOK_PATH}${m.key}/${encodeURIComponent(c.url)}`, self.location.origin).href;

/** A printing's vector from this device: memory, or the Cache API (kept in memory then); null when neither has it. */
async function kept(m: { key: string }, c: LookCandidate, cache: Cache | null): Promise<LookEmbedding | null> {
  const memo = `${m.key}|${c.url}`;
  const hit = keys.get(memo);
  if (hit) return hit;
  const res = await cache?.match(cacheUrlOf(m, c));
  const unpacked = res ? unpackLook(new Float32Array(await res.arrayBuffer())) : null;
  if (unpacked) remember(memo, unpacked);
  return unpacked;
}

/** A printing's vector: from this device, the server's answer (`server`), or its picture fetched and embedded here. */
async function key(m: { session: LookSession; key: string }, c: LookCandidate, times: Times, server: ServerAnswer, signal?: AbortSignal): Promise<LookEmbedding> {
  const cache = await caches.open(LOOK_CACHE).catch(() => null);
  const own = await kept(m, c, cache);
  if (own) {
    times.cached += 1;
    return own;
  }
  const got = await serverOrOwn((s) => make(m, c, times, s), server, c.url, signal);
  if (got.server) times.server += 1;
  remember(`${m.key}|${c.url}`, got.key);
  if (cache) {
    await cache.put(cacheUrlOf(m, c), new Response(packLook(got.key).buffer as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
    if (++putsSinceTrim >= 100) {
      putsSinceTrim = 0;
      await trim(cache).catch(() => undefined);
    }
  }
  return got.key;
}

/** A printing's picture fetched from Scryfall and embedded here. */
async function make(m: { session: LookSession; key: string }, c: LookCandidate, times: Times, signal?: AbortSignal): Promise<LookEmbedding> {
  const { pixels, fetchMs, decodeMs } = await picture(c.url, signal);
  if (signal?.aborted) throw new Error("The server's vector came first");
  const t2 = performance.now();
  const e = await embedLook(m.session, Tensor, { width: pixels.width, height: pixels.height, data: pixels.data }, cornersOf(pixels.width, pixels.height));
  times.fetchMs += fetchMs;
  times.decodeMs += decodeMs;
  times.embedMs += performance.now() - t2;
  return e;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A printing's Scryfall picture, fetched and decoded to pixels, with how long each took. */
async function picture(url: string, signal?: AbortSignal): Promise<{ pixels: ImageData; fetchMs: number; decodeMs: number }> {
  // cards.scryfall.io answers with Access-Control-Allow-Origin: *, so its pixels can be read.
  // "no-store": the service worker serves a picture it has, but doesn't keep these in the offline
  // image cache (public/sw.js), which a big scan would otherwise churn.
  const t0 = performance.now();
  const res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store", signal });
  if (!res.ok) throw new Error(`Couldn't fetch ${url} (${res.status})`);
  const blob = await res.blob();
  const t1 = performance.now();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { pixels, fetchMs: t1 - t0, decodeMs: performance.now() - t1 };
}

/** The speed test's timing of the look: one picture and one frame, embedded once each, nothing kept. */
async function time(id: number, url: string, frame: WireFrame | null) {
  try {
    if (loading) await loading;
    const m = model;
    if (!m) throw new Error("No look model is loaded");
    const { pixels, fetchMs, decodeMs } = await picture(url);
    const t0 = performance.now();
    await embedLook(m.session, Tensor, { width: pixels.width, height: pixels.height, data: pixels.data }, cornersOf(pixels.width, pixels.height));
    const pictureMs = performance.now() - t0;
    let frameMs: number | null = null;
    if (frame) {
      const t1 = performance.now();
      await embedLook(m.session, Tensor, { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.buffer) }, frame.quad);
      frameMs = performance.now() - t1;
    }
    reply({ type: "timed", id, error: null, fetchMs, decodeMs, pictureMs, frameMs });
  } catch (e) {
    reply({ type: "timed", id, error: e instanceof Error ? e.message : String(e), fetchMs: 0, decodeMs: 0, pictureMs: 0, frameMs: null });
  }
}

async function look(id: number, frames: Extract<LookWorkerRequest, { type: "look" }>["frames"], candidates: LookCandidate[]) {
  const t0 = performance.now();
  const stop = new AbortController();
  runs.set(id, stop);
  const times: Times = { cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0, server: 0 };
  const asking = { asked: 0, serverMs: null as number | null };
  const base = { frames: frames.length, queryMs: 0, scored: 0 };
  try {
    if (loading) await loading;
    const m = model;
    if (!m) throw new Error("No look model is loaded");
    if (frames.length === 0) throw new Error("No frame of this card is kept to compare");
    // The printings this device has no vector for: the server is asked for those (through
    // artClient) while the card's side is embedded. Its answer is empty when it can't be had.
    const cache = await caches.open(LOOK_CACHE).catch(() => null);
    const missing: LookCandidate[] = [];
    for (const c of candidates) if (!(await kept(m, c, cache))) missing.push(c);
    // At most as many as one ask may name (more printings of one artwork are rare); the rest are made here.
    const ask = missing.slice(0, SERVER_MAX_IDS);
    const server = ask.length > 0 ? new ServerAnswer() : ServerAnswer.empty();
    if (ask.length > 0) {
      asking.asked = ask.length;
      answers.set(id, (looks, ms) => {
        answers.delete(id);
        asking.serverMs = looks ? ms : null;
        server.give(serverKeys(ask, looks));
      });
      stop.signal.addEventListener("abort", () => answers.get(id)?.(null, null), { once: true });
      reply({ type: "need", id, model: m.key, candidates: ask });
    }
    const seen: LookEmbedding[] = [];
    for (const f of frames) {
      if (stop.signal.aborted) break;
      seen.push(await embedLook(m.session, Tensor, { width: f.width, height: f.height, data: new Uint8ClampedArray(f.buffer) }, f.quad));
    }
    const query = meanEmbedding(seen);
    if (!query) throw new Error("The look was stopped");
    const queryMs = performance.now() - t0;
    // The server's answer is worth a moment: its vectors cost nothing more here, where a picture
    // fetched from Scryfall takes about half a second on a cold connection.
    if (!server.done) await Promise.race([server.promise, sleep(Math.max(0, t0 + SERVER_WAIT_MS - performance.now()))]);
    const scored = await scoreCandidates(query, candidates, (c, signal) => key(m, c, times, server, signal), (candidate, score) => reply({ type: "score", id, candidate, score }), {
      concurrency: AT_ONCE,
      signal: stop.signal,
    });
    reply({ type: "done", id, error: null, model: m.key, frames: frames.length, queryMs, scored, ...times, ...asking, ms: performance.now() - t0 });
  } catch (e) {
    reply({ type: "done", id, error: e instanceof Error ? e.message : String(e), model: model?.key ?? "", ...base, ...times, ...asking, ms: performance.now() - t0 });
  } finally {
    answers.get(id)?.(null, null);
    runs.delete(id);
  }
}

self.onmessage = async (event: MessageEvent<LookWorkerRequest>) => {
  const m = event.data;
  if (m.type === "model") {
    const now = load(m.url, m.bytes, m.cache === false);
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
  else if (m.type === "time") void time(m.id, m.url, m.frame);
  else if (m.type === "keys") answers.get(m.id)?.(m.looks, m.ms);
  else if (m.type === "stop") runs.get(m.id)?.abort();
};
