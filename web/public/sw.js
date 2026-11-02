// Yama service worker: the app shell, its code and card images work offline; the API never comes
// from cache.
//
// Cache busting (2026-11-02, ARCHITECTURE.md "Caching and cache busting"): the shell (/) is always
// asked of the network first and kept for offline use. Its code lives at content-hashed
// /assets/ addresses that never change meaning, so they are kept until no recent shell needs
// them. Every build lists its code in /assets/precache-<hash>.json, named by the shell's
// <meta name="yama-precache">: when a new shell arrives, the worker saves everything it lists,
// so pages opened later work offline too, and drops what neither this shell nor the one before
// it uses (a tab opened before a release keeps working).
const SHELL = "yama-shell-v2";
const ASSETS = "yama-assets-v2";
/** v1 kept opaque responses (no CORS), which hid failures and counted several MB each. */
const IMAGES = "yama-images-v2";
const MAX_IMAGES = 1500;
const SELECT_CHEVRON = "/select-chevron-v1.svg";
/** The scanner's recognition bundle, cached by its worker (src/scanner/art.worker.ts). */
const SCAN = "yama-scan-v1";
/** Which builds' code the asset cache keeps: the current shell's list and the one before. */
const BUILDS = "/__yama/builds";
/** How long a page load waits for the network before opening the saved shell. */
const NETWORK_WAIT_MS = 3000;
/**
 * Saved answers are matched by address alone. The server's CORS layer sends `Vary: Origin`, and
 * the page asks for its code with an Origin header while this worker saves it without one; a
 * content-hashed file is the same for every origin.
 */
const BY_URL = { ignoreVary: true };

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", SELECT_CHEVRON]))
      // The shell is saved; its code is saved too if it can be (offline, it's saved as pages open).
      .then(() => caches.match("/", BY_URL).then((res) => res && adoptShell(res)).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL, ASSETS, IMAGES, SCAN];
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => trim(IMAGES, MAX_IMAGES))
      .then(() => self.clients.claim()),
  );
});

/** A page's answer that is the app shell, fit to keep for offline use. */
function isShell(res) {
  return res.ok && res.type === "basic" && !res.redirected && (res.headers.get("content-type") || "").includes("text/html");
}

/**
 * What a file at `path` must be served as. The server used to answer a missing /assets/ file with
 * the shell (HTML, 200); kept under a .js address, that broke the app until the cache was cleared.
 */
function expectedType(path) {
  if (/\.(m?js)$/.test(path)) return /javascript/;
  if (path.endsWith(".css")) return /text\/css/;
  if (path.endsWith(".json")) return /json/;
  if (path.endsWith(".svg")) return /image\/svg/;
  if (path.endsWith(".wasm")) return /wasm|octet-stream/;
  if (/\.woff2?$/.test(path)) return /font|octet-stream/;
  return null;
}

/** A static file's answer that is what it says it is. */
function isAsset(res, path) {
  if (!res.ok) return false;
  const type = res.headers.get("content-type") || "";
  const want = expectedType(path);
  return want ? want.test(type) : !type.includes("text/html");
}

/** The build list named by a shell, if it names one. */
async function buildListUrl(shell) {
  const html = await shell.clone().text();
  return html.match(/<meta name="yama-precache" content="(\/assets\/precache-[\w-]+\.json)"/)?.[1] ?? null;
}

async function readBuilds() {
  const res = await (await caches.open(SHELL)).match(BUILDS);
  return res ? res.json() : { current: null, previous: null };
}

/**
 * A new shell: save the code its build lists and forget code no recent build uses. Runs after
 * install and whenever a page load brings a different shell. A failure leaves things as they were;
 * the next page load tries again.
 */
async function adoptShell(shell) {
  const url = await buildListUrl(shell);
  if (!url) return;
  const builds = await readBuilds();
  if (builds.current?.url === url) return;
  const res = await fetch(url);
  if (!isAsset(res, url)) return;
  const list = await res.json();
  // `precache`: saved now. `files`: the whole build, kept once saved (the scanner's 15 MB
  // WASM is saved only when someone scans). `keep`: folders kept whole (the OCR engine).
  const build = { url, files: list.files || [], keep: list.keep || [] };
  const cache = await caches.open(ASSETS);
  const queue = (list.precache || []).slice();
  // A few at a time, so a phone's connection isn't swamped while someone uses the page.
  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      for (let path = queue.shift(); path; path = queue.shift()) {
        if (await cache.match(path, BY_URL)) continue;
        const res = await fetch(path).catch(() => null);
        if (res && isAsset(res, path)) await cache.put(path, res);
      }
    }),
  );
  const next = { current: build, previous: builds.current ?? builds.previous };
  await (await caches.open(SHELL)).put(BUILDS, new Response(JSON.stringify(next), { headers: { "content-type": "application/json" } }));
  await prune(next);
}

/** Drop build code that neither the current shell nor the one before it uses. */
async function prune(builds) {
  const lists = [builds.current, builds.previous].filter(Boolean);
  const keep = new Set(lists.flatMap((b) => b.files));
  const prefixes = lists.flatMap((b) => b.keep);
  const cache = await caches.open(ASSETS);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    // Only build output: /assets/ (hashed) and /ocr/<version>/; anything else stays.
    if (!path.startsWith("/assets/") && !path.startsWith("/ocr/")) continue;
    if (keep.has(path) || prefixes.some((p) => path.startsWith(p))) continue;
    await cache.delete(req);
  }
}

/** Keep the newest `max` entries of a cache (entries list oldest first). */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** Card images saved since the image cache was last trimmed; trimming lists every key, so it's batched. */
let imagesSinceTrim = -1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A page load: the network's shell if it answers within a few seconds, otherwise the saved one.
 * A late answer still replaces the saved shell for next time.
 */
function openPage(event) {
  const network = fetch(event.request);
  const saved = network.then((res) => {
    if (!isShell(res)) return;
    // Copies taken now, before the page starts reading the answer.
    const copy = res.clone();
    const forList = res.clone();
    return caches.open(SHELL).then((c) => c.put("/", copy)).then(() => adoptShell(forList));
  });
  event.waitUntil(saved.catch(() => undefined));
  return caches.match("/", { cacheName: SHELL, ...BY_URL }).then((cached) => {
    if (!cached) return network;
    const fresh = network.then((res) => (res.status >= 500 ? cached : res)).catch(() => cached);
    return Promise.race([fresh, sleep(NETWORK_WAIT_MS).then(() => cached)]);
  });
}

/**
 * A Scryfall image, asked for with CORS (Scryfall allows any origin) so the answer can be checked
 * and kept at its real size. Only images that arrived whole are kept.
 */
async function cardImage(event) {
  const req = event.request;
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(req.url, BY_URL);
  if (hit) return hit;
  let res;
  try {
    res = await fetch(req.url, { mode: "cors", credentials: "omit" });
  } catch (e) {
    // No CORS answer: a plain <img> can still show an opaque one; it just isn't kept.
    if (req.mode === "no-cors") return fetch(req);
    throw e;
  }
  if (res.ok) {
    const copy = res.clone();
    event.waitUntil(
      cache.put(req.url, copy).then(() => {
        // Trim once when the worker starts, then every 50 new images.
        if (imagesSinceTrim >= 0 && ++imagesSinceTrim < 50) return;
        imagesSinceTrim = 0;
        return trim(IMAGES, MAX_IMAGES);
      }),
    );
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return; // always live
  // Public reference/notice pages, exports and phase's board (/board/, its own app and service
  // worker) are not the private app shell: never cache them as "/".
  if (url.origin === location.origin && (/^\/(about|privacy|tos|delete-account|precons|commanders|docs|u|d|r|board)(\/|$)/.test(url.pathname) || url.pathname === "/sitemap.xml")) return;

  if (req.mode === "navigate") {
    event.respondWith(openPage(event));
    return;
  }

  // Build code, the OCR engine and the versioned control icon: from the device once saved.
  if (url.origin === location.origin && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/ocr/") || url.pathname === SELECT_CHEVRON)) {
    event.respondWith(
      caches.match(req, BY_URL).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (isAsset(res, url.pathname)) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Scryfall card images: keep the ones you've seen for offline lookups at the table.
  if (url.hostname === "cards.scryfall.io") event.respondWith(cardImage(event));
});
