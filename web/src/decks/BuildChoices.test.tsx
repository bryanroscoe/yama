import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { BuildChoicesPage, SwapFace } from "./BuildChoices";
import { duplexPages, type BuildChoice } from "./buildCatalog";

// Navigation uses browser-only outbox subscriptions; keep real auth/plan hooks for cache tests.
vi.mock("../components/DeckTabs", () => ({ AreaHead: ({ title }: { title: string }) => <h1>{title}</h1> }));

const from: BuildChoice = { id: "a", label: "[2] Plan", kind: "bracket", list: "", source: "Plan v27", href: "/", warnings: [] };
const to: BuildChoice = { ...from, id: "b", label: "[3] Plan" };
const change = { out: { name: "Clever Concealment", board: "main" as const }, in: { name: "Teferi's Protection", board: "main" as const } };
describe("duplex card content", () => {
  it("renders full card names with previews, exact directions, part number and source", () => {
    const pages = duplexPages([change]);
    const front = renderToStaticMarkup(<SwapFace face={pages[0]![0]!} name="Lorehold Spirit" from={from} to={to} parts={1} versions={[]} />);
    const back = renderToStaticMarkup(<SwapFace face={pages[1]![2]!} name="Lorehold Spirit" from={from} to={to} parts={1} versions={[]} />);
    expect(front).toContain("[2] Plan → [3] Plan");
    expect(back).toContain("[3] Plan → [2] Plan");
    expect(front).toContain("Front, part 1 of 1");
    expect(back).toContain("Back, part 1 of 1");
    expect(front.indexOf("Clever Concealment")).toBeLessThan(front.indexOf("Teferi"));
    expect(back.indexOf("Teferi")).toBeLessThan(back.indexOf("Clever Concealment"));
    expect(front).toContain('class="card-ref"');
    expect(front).toContain("Plan v27");
  });
});

describe("build data privacy", () => {
  it("uses the shared owner plan cache and loses it when device plan data is purged", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    qc.setQueryData(["me"], { id: "owner-a" });
    qc.setQueryData(["research", "owner-a", "builds"], []);
    qc.setQueryData(["decks"], []);
    const plan = { decks: [{ key: "private", name: "Private paid-price plan", states: {} }] };
    qc.setQueryData(["plan", "owner-a"], plan);
    const render = () => renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter><BuildChoicesPage /></MemoryRouter></QueryClientProvider>);
    expect(render()).toContain("Private paid-price plan");
    // The same prefix removals used by both Settings and failed-logout cleanup.
    qc.removeQueries({ queryKey: ["plan"] });
    qc.removeQueries({ queryKey: ["plan-cache"] });
    expect(qc.getQueryCache().getAll().some((q) => q.state.data === plan)).toBe(false);
    expect(render()).not.toContain("Private paid-price plan");
    qc.clear();
  });
  it("does not reuse another owner's plan or research when the signed-in identity changes", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    qc.setQueryData(["me"], { id: "owner-b" });
    qc.setQueryData(["decks"], []);
    qc.setQueryData(["plan", "owner-a"], { decks: [{ key: "private", name: "Owner A private plan", states: {} }] });
    qc.setQueryData(["research", "owner-a", "builds"], [{ document: { id: "private-report", title: "Private", decks: [{ key: "k", name: "Owner A private research", builds: [] }] }, revision: 1, updated_at: "2026-10-31" }]);
    qc.setQueryData(["plan", "owner-b"], { decks: [] });
    qc.setQueryData(["research", "owner-b", "builds"], []);
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter><BuildChoicesPage /></MemoryRouter></QueryClientProvider>);
    expect(html).not.toContain("Owner A private");
    expect(html).toContain("No saved decks or researched bracket builds yet");
    qc.clear();
  });
});
