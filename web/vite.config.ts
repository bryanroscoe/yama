import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The Rust server; run it with `cargo run -p yama-server -- serve`.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
      // Claude's tools and their OAuth sign-in (server/src/mcp, server/src/oauth). `/oauth/authorize`
      // stays here: it's the web app's consent page.
      "^/(mcp|oauth/(register|token|revoke)|\\.well-known/oauth-)": { target: "http://127.0.0.1:8787" },
    },
  },
});
