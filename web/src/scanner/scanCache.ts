// The scanner workers' files (the art bundle, the art and look models, the WASM runtime): kept in
// the Cache API by URL, so a second scan starts without downloading. Used by art.worker.ts and
// look.worker.ts.

/** Also listed in public/sw.js, so the service worker's clean-up keeps it. */
export const SCAN_CACHE = "yama-scan-v1";

/** A file from the cache, or downloaded (with progress) and cached. */
export async function cachedFile(url: string, size: number, onBytes: (n: number, total: number) => void): Promise<Uint8Array> {
  const cache = await caches.open(SCAN_CACHE).catch(() => null);
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
