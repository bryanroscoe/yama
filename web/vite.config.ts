import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    // A changed worker must reach browsers even when a CDN retains the old /sw.js.
    "import.meta.env.VITE_SW_VERSION": JSON.stringify(createHash("sha256").update(readFileSync(new URL("./public/sw.js", import.meta.url))).digest("hex").slice(0, 16)),
  },
  server: {
    port: 5173,
    // The Rust server; run it with `cargo run -p yama-server -- serve`.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
      "^/(precons(?:/|$)|[ud]/|sitemap\\.xml$)": { target: "http://127.0.0.1:8787" },
      // Claude's tools and their OAuth sign-in (server/src/mcp, server/src/oauth). `/oauth/authorize`
      // stays here: it's the web app's consent page.
      "^/(mcp|oauth/(register|token|revoke)|\\.well-known/oauth-)": { target: "http://127.0.0.1:8787" },
    },
  },
});
