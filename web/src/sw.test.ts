// The service worker (public/sw.js), run in a sandbox with an in-memory Cache API and network.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://yama.ing";
const SW = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

type Net = (url: string, init?: RequestInit) => Promise<Response>;

/** A response as the browser's fetch gives it for this origin ("basic"). */
function res(body: string, type: string, status = 200): Response {
  const r = new Response(status === 204 ? null : body, { status, headers: { "content-type": type } });
  Object.defineProperty(r, "type", { value: "basic" });
  return r;
}

const shellHtml = (list: string) => `<!doctype html><html><head><meta name="yama-precache" content="${list}" /></head><body></body></html>`;

function worker(net: Net, { wait = (fn: () => void, ms: number) => setTimeout(fn, ms) } = {}) {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: string | { url: string }) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  const fetched: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (r: string | { url: string }, init?: RequestInit) => {
    const url = key(r);
    fetched.push({ url, init });
    return net(url, init);
  };
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (r: string | { url: string }) => m.get(key(r))?.clone(),
      put: async (r: string | { url: string }, response: Response) => void m.set(key(r), response),
      addAll: async (paths: string[]) => {
        for (const p of paths) {
          const response = await fetchFn(p);
          if (!response.ok) throw new Error(`addAll ${p}`);
          m.set(key(p), response);
        }
      },
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (r: string | { url: string }) => m.delete(key(r)),
    };
  };
  let keyLists = 0;
  const caches = {
    open: async (name: string) => {
      const s = store(name);
      return { ...s, keys: async () => (keyLists++, s.keys()) };
    },
    match: async (r: string | { url: string }, opts?: { cacheName?: string }) => {
      for (const [name, m] of stores) if (!opts?.cacheName || opts.cacheName === name) {
        const hit = m.get(key(r));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const listeners = new Map<string, (event: unknown) => void>();
  runInNewContext(SW, {
    self: { addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    location: { origin: ORIGIN },
    URL,
    Response,
    caches,
    fetch: fetchFn,
    setTimeout: wait,
  });
  /** Fire an event and wait for everything it started, as the browser keeps the worker alive. */
  async function fire(name: string, request?: { url: string; mode: string; method?: string }) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners.get(name)!({
      request: request && { method: "GET", ...request, url: key(request) },
      respondWith: (p: Promise<Response>) => (response = p),
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    const answer = response ? await response : undefined;
    // waitUntil can be called again while earlier work runs.
    for (let i = 0; i < pending.length; i++) await pending[i];
    return answer;
  }
  const cached = (name: string, path: string) => stores.get(name)?.has(key(path)) ?? false;
  return { fire, cached, stores, fetched, keyLists: () => keyLists };
}

describe("the service worker", () => {
  it("never keeps the shell's HTML under a build file's address", async () => {
    let missing = true;
    const sw = worker(async (url) => (missing ? res("<!doctype html>", "text/html") : res("export {}", "text/javascript")));
    const first = await sw.fire("fetch", { url: "/assets/index-abc.js", mode: "cors" });
    expect(first?.headers.get("content-type")).toBe("text/html");
    expect(sw.cached("yama-assets-v2", "/assets/index-abc.js")).toBe(false);
    missing = false;
    await sw.fire("fetch", { url: "/assets/index-abc.js", mode: "cors" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.cached("yama-assets-v2", "/assets/index-abc.js")).toBe(true);
  });

  it("opens the saved shell when the network is slow, and keeps the late answer for next time", async () => {
    let answer: (r: Response) => void = () => {};
    const sw = worker(
      (url) => (url === `${ORIGIN}/decks` ? new Promise((r) => (answer = r)) : Promise.resolve(res("", "text/plain", 404))),
      // The three-second wait is over at once.
      { wait: (fn) => setTimeout(fn, 0) },
    );
    sw.stores.set("yama-shell-v2", new Map([[`${ORIGIN}/`, res("old shell", "text/html")]]));
    const pending = sw.fire("fetch", { url: "/decks", mode: "navigate" });
    await new Promise((r) => setTimeout(r, 5));
    answer(res("new shell", "text/html"));
    expect(await (await pending)!.text()).toBe("old shell");
    expect(await sw.stores.get("yama-shell-v2")!.get(`${ORIGIN}/`)!.clone().text()).toBe("new shell");
  });

  it("opens the saved shell offline or when the server is failing, and the network's otherwise", async () => {
    let mode: "offline" | "down" | "up" = "offline";
    const sw = worker(async () => {
      if (mode === "offline") throw new TypeError("Failed to fetch");
      return mode === "down" ? res("bad gateway", "text/html", 502) : res("fresh", "text/html");
    });
    sw.stores.set("yama-shell-v2", new Map([[`${ORIGIN}/`, res("saved", "text/html")]]));
    expect(await (await sw.fire("fetch", { url: "/", mode: "navigate" }))!.text()).toBe("saved");
    mode = "down";
    expect(await (await sw.fire("fetch", { url: "/", mode: "navigate" }))!.text()).toBe("saved");
    mode = "up";
    expect(await (await sw.fire("fetch", { url: "/", mode: "navigate" }))!.text()).toBe("fresh");
  });

  it("saves a new build's code and drops code neither it nor the build before it uses", async () => {
    const lists: Record<string, object> = {
      "/assets/precache-a.json": { precache: ["/assets/a.js"], files: ["/assets/a.js"], keep: ["/ocr/v1/"] },
      "/assets/precache-b.json": { precache: ["/assets/b.js", "/assets/b.css"], files: ["/assets/b.js", "/assets/b.css", "/assets/big.wasm"], keep: ["/ocr/v1/"] },
      "/assets/precache-c.json": { precache: ["/assets/c.js"], files: ["/assets/c.js", "/assets/big.wasm"], keep: ["/ocr/v2/"] },
    };
    let shell = "/assets/precache-a.json";
    const sw = worker(async (url) => {
      const path = new URL(url).pathname;
      // Every app address answers with the shell.
      if (!path.includes(".")) return res(shellHtml(shell), "text/html");
      if (lists[path]) return res(JSON.stringify(lists[path]), "application/json");
      if (path.endsWith(".js")) return res("export {}", "text/javascript");
      if (path.endsWith(".css")) return res("", "text/css");
      if (path.endsWith(".wasm")) return res("", "application/wasm");
      return res("", "text/plain");
    });
    await sw.fire("install");
    expect(sw.cached("yama-assets-v2", "/assets/a.js")).toBe(true);
    // Code fetched as pages need it: the scanner's WASM and the OCR engine.
    await sw.fire("fetch", { url: "/assets/big.wasm", mode: "cors" });
    await sw.fire("fetch", { url: "/ocr/v1/worker.min.js", mode: "cors" });
    await new Promise((r) => setTimeout(r, 0));
    shell = "/assets/precache-b.json";
    await sw.fire("fetch", { url: "/lab", mode: "navigate" });
    expect(sw.cached("yama-assets-v2", "/assets/b.js")).toBe(true);
    expect(sw.cached("yama-assets-v2", "/assets/b.css")).toBe(true);
    // The build before still has its code, for a tab opened before the release.
    expect(sw.cached("yama-assets-v2", "/assets/a.js")).toBe(true);
    shell = "/assets/precache-c.json";
    await sw.fire("fetch", { url: "/", mode: "navigate" });
    expect(sw.cached("yama-assets-v2", "/assets/c.js")).toBe(true);
    expect(sw.cached("yama-assets-v2", "/assets/b.js")).toBe(true);
    expect(sw.cached("yama-assets-v2", "/assets/a.js")).toBe(false);
    // Listed by a recent build though never saved up front, so it stays.
    expect(sw.cached("yama-assets-v2", "/assets/big.wasm")).toBe(true);
    // The previous build's OCR folder stays; it goes with the next release.
    expect(sw.cached("yama-assets-v2", "/ocr/v1/worker.min.js")).toBe(true);
    // The same shell again does nothing new.
    const before = sw.fetched.length;
    await sw.fire("fetch", { url: "/", mode: "navigate" });
    expect(sw.fetched.length - before).toBe(1);
  });

  it("adopts the shell it just saved, not an older worker's, when it installs", async () => {
    const sw = worker(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/") return res(shellHtml("/assets/precache-n.json"), "text/html");
      if (path === "/assets/precache-n.json") return res(JSON.stringify({ precache: ["/assets/n.js"], files: ["/assets/n.js"], keep: [] }), "application/json");
      return path.endsWith(".js") ? res("export {}", "text/javascript") : res("", "text/plain");
    });
    // v1's shell, older and first in line, with no build list.
    sw.stores.set("yama-shell-v1", new Map([[`${ORIGIN}/`, res("<!doctype html><title>old</title>", "text/html")]]));
    await sw.fire("install");
    expect(sw.cached("yama-assets-v2", "/assets/n.js")).toBe(true);
  });

  it("tries again for build files that didn't arrive", async () => {
    let flaky = true;
    const sw = worker(async (url) => {
      const path = new URL(url).pathname;
      if (!path.includes(".")) return res(shellHtml("/assets/precache-f.json"), "text/html");
      if (path === "/assets/precache-f.json") return res(JSON.stringify({ precache: ["/assets/f1.js", "/assets/f2.js"], files: ["/assets/f1.js", "/assets/f2.js"], keep: [] }), "application/json");
      if (path === "/assets/f2.js" && flaky) throw new TypeError("Failed to fetch");
      return res("export {}", "text/javascript");
    });
    await sw.fire("install");
    expect(sw.cached("yama-assets-v2", "/assets/f1.js")).toBe(true);
    expect(sw.cached("yama-assets-v2", "/assets/f2.js")).toBe(false);
    flaky = false;
    await sw.fire("fetch", { url: "/", mode: "navigate" });
    expect(sw.cached("yama-assets-v2", "/assets/f2.js")).toBe(true);
    // Complete now: the next page load asks for nothing but the shell.
    const before = sw.fetched.length;
    await sw.fire("fetch", { url: "/", mode: "navigate" });
    expect(sw.fetched.length - before).toBe(1);
  });

  it("asks Scryfall for images with CORS and keeps only whole ones", async () => {
    const sw = worker(async (url) => (url.includes("missing") ? new Response("", { status: 404 }) : new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } })));
    const img = "https://cards.scryfall.io/normal/front/a/b/ab.jpg";
    await sw.fire("fetch", { url: img, mode: "no-cors" });
    expect(sw.fetched.at(-1)?.init).toMatchObject({ mode: "cors", credentials: "omit" });
    expect(sw.cached("yama-images-v2", img)).toBe(true);
    const missing = "https://cards.scryfall.io/normal/front/a/b/missing.jpg";
    expect((await sw.fire("fetch", { url: missing, mode: "cors" }))?.status).toBe(404);
    expect(sw.cached("yama-images-v2", missing)).toBe(false);
    // A second look comes from the device.
    const count = sw.fetched.length;
    await sw.fire("fetch", { url: img, mode: "no-cors" });
    expect(sw.fetched.length).toBe(count);
  });

  it("trims the image cache in batches, not on every new image", async () => {
    const sw = worker(async () => new Response("img", { status: 200, headers: { "content-type": "image/webp" } }));
    for (let i = 0; i < 120; i++) await sw.fire("fetch", { url: `https://cards.scryfall.io/small/front/${i}.webp`, mode: "cors" });
    // Once when the worker starts, then every 50 images.
    expect(sw.keyLists()).toBe(3);
  });
});
