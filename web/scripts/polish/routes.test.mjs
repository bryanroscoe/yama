import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageLinks, patternFor, patternMatcher, routesFromApp, sampleKey, slugFor } from "./routes.mjs";

const APP = `
<Routes>
  <Route path="/oauth/authorize" element={<OAuthConsent />} />
  <Route element={<Shell />}>
    <Route index element={<Home />} />
    <Route path="decks" element={<Decks />} />
    <Route path="decks/plan" element={<PlanLayout a={{ b: 1 }} />}>
      <Route index element={<Overview />} />
      <Route path="d/:key" element={<DeckPlan />} />
    </Route>
    <Route path="decks/lab/*" element={<Old />} />
    <Route path="decks/:id" element={<Deck />} />
  </Route>
</Routes>`;

describe("polish routes", () => {
  it("reads nested routes from App.tsx source", () => {
    expect(routesFromApp(APP)).toEqual(["/oauth/authorize", "/", "/decks", "/decks/plan", "/decks/plan/d/:key", "/decks/:id"]);
  });

  it("finds the real app's main pages", () => {
    const routes = routesFromApp(readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8"));
    for (const r of ["/", "/decks", "/cards", "/collection", "/decks/:id"]) expect(routes).toContain(r);
    expect(routes.some((r) => r.includes("*"))).toBe(false);
  });

  it("groups URLs by pattern, static routes first", () => {
    const m = ["/decks/plan", "/decks/:id", "/decks/plan/d/:key"].map(patternMatcher);
    expect(patternFor("/decks/plan", m)).toBe("/decks/plan");
    expect(patternFor("/decks/abc123", m)).toBe("/decks/:id");
    expect(patternFor("/decks/plan/d/xyz", m)).toBe("/decks/plan/d/:key");
    expect(patternFor("/precons/some-deck", m)).toBe("/precons/:id");
    expect(sampleKey(new URL("https://x/decks/1?tab=a&b=2"), m)).toBe("/decks/:id?b&tab");
    const server = ["/precons/methodology", "/precons/:slug"].map(patternMatcher);
    expect(patternFor("/precons/methodology", server)).toBe("/precons/methodology");
    expect(patternFor("/precons/tinker-time", server)).toBe("/precons/:slug");
  });

  it("names files safely", () => {
    expect(slugFor(new URL("https://x/"))).toMatch(/^home-[0-9a-f]{6}$/);
    expect(slugFor(new URL("https://x/decks/plan/d/ab_c?x=1"))).toMatch(/^decks-plan-d-ab-c-x-1-[0-9a-f]{6}$/);
    expect(slugFor(new URL("https://x/cards?q=A-B"))).not.toBe(slugFor(new URL("https://x/cards?q=A.B")));
  });
});

describe("links found on a page", () => {
  afterEach(() => vi.unstubAllGlobals());
  /** An anchor as the page has it: HTML ones give `href` as a string, SVG ones as an SVGAnimatedString. */
  const anchor = (href, attrs = {}) => ({ href, hasAttribute: (name) => name in attrs, getAttribute: (name) => attrs[name] ?? null });

  it("reads an SVG link's address instead of crashing on it", () => {
    vi.stubGlobal("document", { baseURI: "https://yama.ing/precons" });
    const links = pageLinks([
      anchor("https://yama.ing/precons/riders-of-rohan"),
      // The charts on /precons link their marks: `href` is an object with baseVal, often relative.
      anchor({ baseVal: "/precons/food-and-fellowship", animVal: "/precons/food-and-fellowship" }),
      anchor({ baseVal: "methodology" }),
    ]);
    expect(links).toEqual(["https://yama.ing/precons/riders-of-rohan", "https://yama.ing/precons/food-and-fellowship", "https://yama.ing/methodology"]);
    // Every one is an address the crawl can open.
    for (const l of links) expect(() => new URL(l)).not.toThrow();
  });

  it("leaves out downloads and links that aren't addresses", () => {
    vi.stubGlobal("document", { baseURI: "https://yama.ing/decks" });
    expect(pageLinks([anchor("https://yama.ing/export.csv", { download: "" }), anchor({ baseVal: "" }), anchor("http://[broken"), anchor("https://yama.ing/cards")])).toEqual(["https://yama.ing/cards"]);
  });
});
