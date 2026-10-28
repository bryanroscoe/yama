import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteNotice } from "./components/SiteNotice";

describe("public reference and content rights", () => {
  it("includes every embedded web stylesheet in the server Docker build context", () => {
    const renderer = readFileSync(new URL("../../server/src/public_precons/html.rs", import.meta.url), "utf8");
    const dockerfile = readFileSync(new URL("../../deploy/Dockerfile", import.meta.url), "utf8");
    const copies = dockerfile.split("\n").filter(line => line.startsWith("COPY ")).flatMap(line => line.split(/\s+/).slice(1, -1));
    for (const [, path] of renderer.matchAll(/include_str!\("\.\.\/\.\.\/\.\.\/(web\/[^"]+\.css)"\)/g)) {
      expect(copies, path).toContain(path);
    }
  });

  it("serves the select icon offline immediately after the app is installed", async () => {
    const origin = "https://yama.ing";
    const css = readFileSync(new URL("./controls.css", import.meta.url), "utf8");
    const icon = css.match(/background-image:\s*url\("([^"]+)"\)/)?.[1];
    expect(icon).toBeTruthy();
    const cached = new Map<string, object>();
    const listeners = new Map<string, (event: unknown) => void>();
    let networkCalls = 0;
    runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
      self: {
        addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
        skipWaiting: () => Promise.resolve(),
      },
      location: { origin },
      URL,
      caches: {
        open: async () => ({ addAll: async (paths: string[]) => {
          for (const path of paths) cached.set(new URL(path, origin).href, { path });
        } }),
        match: async (request: { url: string }) => cached.get(request.url),
      },
      fetch: async () => { networkCalls++; throw new Error("Offline"); },
    });
    let installation: Promise<unknown> | undefined;
    listeners.get("install")!({ waitUntil: (promise: Promise<unknown>) => { installation = promise; } });
    await installation;
    const url = new URL(icon!, origin).href;
    expect(cached.has(url)).toBe(true);
    let response: Promise<unknown> | undefined;
    listeners.get("fetch")!({
      request: { method: "GET", mode: "no-cors", url },
      respondWith: (promise: Promise<unknown>) => { response = promise; },
    });
    expect(response).toBeDefined();
    expect(await response).toBe(cached.get(url));
    expect(networkCalls).toBe(0);
  });

  it("keeps public pages and stock exports out of the private offline shell", () => {
    let fetchHandler: (event: { request: { method: string; mode: string; url: string }; respondWith: () => void }) => void = () => {};
    runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
      self: { addEventListener: (name: string, fn: typeof fetchHandler) => { if (name === "fetch") fetchHandler = fn; } },
      location: { origin: "https://yama.saget.org" },
      URL,
    });
    for (const path of ["/precons", "/precons?c=UG", "/precons/a-deck", "/precons/a-deck/decklist.txt", "/precons/methodology", "/docs/mcp", "/docs/mcp/", "/docs/mcp/guide.css", "/sitemap.xml", "/api/public/precons"]) {
      let intercepted = false;
      fetchHandler({ request: { method: "GET", mode: "navigate", url: `https://yama.saget.org${path}` }, respondWith: () => { intercepted = true; } });
      expect(intercepted, path).toBe(false);
    }
  });

  it("reserves Yama's original work while keeping third-party ownership clear", () => {
    const markup = renderToStaticMarkup(<SiteNotice />);
    expect(markup).toContain("All rights reserved");
    expect(markup).toContain("Bryan Roscoe");
    expect(markup).toContain("Third-party content belongs to its respective owners");
    expect(markup).toContain("not affiliated with, endorsed by, or sponsored by Wizards");
    for (const path of ["about", "privacy", "tos"]) {
      expect(readFileSync(new URL(`../public/${path}/index.html`, import.meta.url), "utf8"), path).toContain("All rights reserved");
    }
    const terms = readFileSync(new URL("../public/tos/index.html", import.meta.url), "utf8");
    expect(terms).toContain('id="rights"');
    expect(terms).toContain("does not claim exclusive rights in facts");
  });
});
