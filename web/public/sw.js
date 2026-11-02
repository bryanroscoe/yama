// Yama service worker: the app shell and card images work offline; the API never comes from cache.
const SHELL = "yama-shell-v1";
const ASSETS = "yama-assets-v1";
const IMAGES = "yama-images-v1";
const MAX_IMAGES = 1500;
const SELECT_CHEVRON = "/select-chevron-v1.svg";
/** The scanner's recognition bundle, cached by its worker (src/scanner/art.worker.ts). */
const SCAN = "yama-scan-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", SELECT_CHEVRON])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL, ASSETS, IMAGES, SCAN];
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return; // always live
  // Public reference/notice pages and exports are not the private app shell: never cache them as "/".
  if (url.origin === location.origin && (/^\/(about|privacy|tos|delete-account|precons|commanders|docs|u|d|r)(\/|$)/.test(url.pathname) || url.pathname === "/sitemap.xml")) return;

  // Page loads: network first so updates arrive, cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Build assets, the OCR engine and the versioned control icon: cache first.
  if (url.origin === location.origin && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/ocr/") || url.pathname === SELECT_CHEVRON)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(ASSETS).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Scryfall card images: keep the ones you've seen for offline lookups at the table.
  if (url.hostname === "cards.scryfall.io") {
    event.respondWith(
      caches.open(IMAGES).then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok || res.type === "opaque") {
                cache.put(req, res.clone());
                trim(IMAGES, MAX_IMAGES);
              }
              return res;
            }),
        ),
      ),
    );
  }
});
