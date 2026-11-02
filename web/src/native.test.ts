import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNative, isServerPage } from "./native";

describe("the Android app", () => {
  it("is off in a browser", () => {
    expect(isNative()).toBe(false);
  });

  it("opens the server's own pages on the server, and keeps the app's pages in the app", () => {
    for (const path of ["/precons", "/precons/methodology", "/commanders", "/about/", "/privacy/", "/tos/", "/delete-account/", "/docs/mcp/", "/u/pat", "/d/abc", "/r/abc", "/sitemap.xml"]) {
      expect(isServerPage(path), path).toBe(true);
    }
    for (const path of ["/", "/decks", "/decks/plan", "/lab", "/lab/runs", "/group", "/play", "/collection", "/cards", "/table/play", "/users", "/docs-ish"]) {
      expect(isServerPage(path), path).toBe(false);
    }
  });

  it("knows every public page the service worker leaves to the server", () => {
    const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    const names = sw.match(/\^\\\/\(([a-z|-]+)\)/)?.[1]?.split("|") ?? [];
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(isServerPage(`/${name}/x`), name).toBe(true);
  });
});
