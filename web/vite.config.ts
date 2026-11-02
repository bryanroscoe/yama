import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import { ocrVersion } from "./scripts/ocr-version.mjs";

const OCR_VERSION = ocrVersion();

/**
 * The build's file list for the service worker (public/sw.js): `/assets/precache-<hash>.json`,
 * named in index.html by `<meta name="yama-precache">`. The worker saves `precache` as soon as it
 * sees a new shell, so every page works offline, not only the ones already opened; it keeps
 * `files` and the `keep` folders and drops other build code (ARCHITECTURE.md, "Caching and cache
 * busting"). The scanner's WASM and the old .woff fallbacks are listed but not saved up front.
 */
function precacheList(): Plugin {
  let outDir = "dist";
  return {
    name: "yama-precache-list",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => f.startsWith("assets/"))
        .sort()
        .map((f) => `/${f}`);
      const precache = files.filter((f) => /\.(js|css|woff2)$/.test(f));
      const keep = [`/ocr/${OCR_VERSION}/`];
      const body = JSON.stringify({ precache, files, keep });
      const name = `assets/precache-${createHash("sha256").update(body).digest("hex").slice(0, 16)}.json`;
      writeFileSync(join(outDir, name), body);
      const index = join(outDir, "index.html");
      const html = readFileSync(index, "utf8");
      if (!html.includes("</head>")) throw new Error("index.html has no </head> for the precache list");
      writeFileSync(index, html.replace("</head>", `  <meta name="yama-precache" content="/${name}" />\n  </head>`));
    },
  };
}

/**
 * `.br` and `.gz` copies beside every compressible file of the build, for the server to send as
 * they are instead of compressing each request (ARCHITECTURE.md, "Caching and cache busting").
 * The Android app (VITE_API_BASE set) carries the build in its package and has no use for them.
 */
function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "yama-precompress",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      if (process.env.VITE_API_BASE) return;
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? walk(path) : [path];
        });
      for (const path of walk(outDir)) {
        if (!/\.(js|mjs|css|html|json|svg|wasm|webmanifest|txt|xml)$/.test(path)) continue;
        const body = readFileSync(path);
        if (body.length < 1024) continue;
        // Brotli's best for the app's code; one step down for the multi-MB engines (the scanner's
        // WASM takes 20 s at 11 and only gains 13%).
        const quality = body.length > 1024 * 1024 ? 9 : 11;
        writeFileSync(`${path}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }));
        writeFileSync(`${path}.gz`, gzipSync(body, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), precacheList(), precompress()],
  define: {
    // A changed worker must reach browsers even when a CDN retains the old /sw.js.
    "import.meta.env.VITE_SW_VERSION": JSON.stringify(createHash("sha256").update(readFileSync(new URL("./public/sw.js", import.meta.url))).digest("hex").slice(0, 16)),
    // The OCR engine's folder under /ocr/ (scripts/copy-ocr.mjs).
    "import.meta.env.VITE_OCR_VERSION": JSON.stringify(OCR_VERSION),
  },
  // The scanner's art recognizer runs in a module worker (src/scanner/art.worker.ts).
  worker: { format: "es" },
  server: {
    port: 5173,
    // The Rust server; run it with `cargo run -p yama-server -- serve`.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
      "^/(precons(?:/|$)|[udr]/|sitemap\\.xml$)": { target: "http://127.0.0.1:8787" },
      // The scanner's recognition bundle (server/src/scan.rs).
      "/scan-bundle": { target: "http://127.0.0.1:8787" },
      // phase's own board (deploy/build-board.sh, served by the server from YAMA_BOARD_DIST).
      "/board": { target: "http://127.0.0.1:8787" },
      // Claude's tools and their OAuth sign-in (server/src/mcp, server/src/oauth). `/oauth/authorize`
      // stays here: it's the web app's consent page.
      "^/(mcp|oauth/(register|token|revoke)|\\.well-known/oauth-)": { target: "http://127.0.0.1:8787" },
    },
  },
});
