import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { patternFor, patternMatcher, routesFromApp, sampleKey, slugFor } from "./routes.mjs";

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
  });

  it("names files safely", () => {
    expect(slugFor(new URL("https://x/"))).toBe("home");
    expect(slugFor(new URL("https://x/decks/plan/d/ab_c?x=1"))).toBe("decks-plan-d-ab-c-x-1");
  });
});
