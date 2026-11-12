import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { BuildChoicesPage, SwapFace } from "./BuildChoices";
import { duplexPages, type BuildChoice } from "./buildCatalog";
import { pictureBatches } from "../components/useCardPictures";
import { buildNotesKey } from "../research/api";

// Navigation uses browser-only outbox subscriptions; keep real auth/plan hooks for cache tests.
vi.mock("../components/DeckTabs", () => ({ AreaHead: ({ title }: { title: string }) => <h1>{title}</h1> }));

const from: BuildChoice = { id: "a", label: "Bracket 2", kind: "bracket", list: "", source: "Plan v27", href: "/", warnings: [] };
const to: BuildChoice = { ...from, id: "b", label: "Bracket 3" };
const change = { out: { name: "Clever Concealment", board: "main" as const }, in: { name: "Teferi's Protection", board: "main" as const } };
describe("duplex card content", () => {
  it("renders full card names with previews, exact directions, part number and source", () => {
    const pages = duplexPages([change]);
    const front = renderToStaticMarkup(<SwapFace face={pages[0]![0]!} name="Lorehold Spirit" from={from} to={to} parts={1} versions={[]} />);
    const back = renderToStaticMarkup(<SwapFace face={pages[1]![2]!} name="Lorehold Spirit" from={from} to={to} parts={1} versions={[]} />);
    expect(front).toContain("Bracket 2 → Bracket 3");
    expect(back).toContain("Bracket 3 → Bracket 2");
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
    qc.setQueryData(buildNotesKey("owner-a"), []);
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
    qc.setQueryData(buildNotesKey("owner-a"), [{ document: { id: "private-report", title: "Private", decks: [{ key: "k", name: "Owner A private research", builds: [] }] }, revision: 1, updated_at: "2026-10-31" }]);
    qc.setQueryData(["plan", "owner-b"], { decks: [] });
    qc.setQueryData(buildNotesKey("owner-b"), []);
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter><BuildChoicesPage /></MemoryRouter></QueryClientProvider>);
    expect(html).not.toContain("Owner A private");
    expect(html).toContain("No saved decks or plan builds yet");
    qc.clear();
  });
});

describe("a deck's swap cards read like its plan page", () => {
  it("shows the deck, its builds as chips, and the changes with their plans' reasons", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    qc.setQueryData(["me"], { id: "owner" });
    qc.setQueryData(["decks"], []);
    qc.setQueryData(["plan", "owner"], { decks: [] });
    const list = (extra: string) => `Commander\n1 Leader\nDeck\n98 Plains\n${extra}`;
    qc.setQueryData(buildNotesKey("owner"), [{ document: { id: "audit", title: "Upgrades", decks: [{ key: "party", name: "Party Time", builds: [
      { id: "b2", label: "Bracket 2 · Core", bracket: 2, list: list("1 Island"), swaps: [] },
      { id: "b3", label: "Bracket 3 · Upgraded", bracket: 3, list: list("1 Sol Ring"), swaps: [{ id: "s", card_in: "Sol Ring", card_out: "Island", why: "Fast mana." }] },
    ] }] }, revision: 1, updated_at: "2026-10-31T19:00:00Z" }]);
    const key = `research:${JSON.stringify(["audit", "party"])}`;
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/decks/builds?deck=${encodeURIComponent(key)}`]}><BuildChoicesPage /></MemoryRouter></QueryClientProvider>);
    qc.clear();
    expect(html).toContain('class="plan-hero-title">Party Time</h1>');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Bracket 3: Upgraded<\/button>/);
    expect(html).toContain("From Upgrades");
    expect(html).toContain("Needs cards bought or printed");
    expect(html).toContain("Changes from");
    expect(html).toContain("Fast mana.");
    expect(html).toContain("1 in, 1 out from Bracket 2: Core");
    expect(html).toContain("Print swap cards");
    expect(html).not.toContain("[3]");
  });
  it("shows each swapped card's picture, looked up by name", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    qc.setQueryData(["me"], { id: "owner" });
    qc.setQueryData(["decks"], []);
    qc.setQueryData(["plan", "owner"], { decks: [] });
    // One search covers both names; Island has no art crop but still has its picture.
    const card = (name: string, file: string, crop: boolean) => ({ name, image_normal: `https://cards.scryfall.io/normal/front/${file}.jpg`, image_art_crop: crop ? "crop.jpg" : null });
    qc.setQueryData(["card-pictures", ["Island", "Sol Ring"]], [card("Sol Ring", "sol", true), card("Island", "island", false)]);
    const list = (extra: string) => `Commander\n1 Leader\nDeck\n98 Plains\n${extra}`;
    qc.setQueryData(buildNotesKey("owner"), [{ document: { id: "audit", title: "Upgrades", decks: [{ key: "party", name: "Party Time", builds: [
      { id: "b2", label: "Bracket 2 · Core", bracket: 2, list: list("1 Island"), swaps: [] },
      { id: "b3", label: "Bracket 3 · Upgraded", bracket: 3, list: list("1 Sol Ring"), swaps: [] },
    ] }] }, revision: 1, updated_at: "2026-10-31T19:00:00Z" }]);
    const key = `research:${JSON.stringify(["audit", "party"])}`;
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/decks/builds?deck=${encodeURIComponent(key)}`]}><BuildChoicesPage /></MemoryRouter></QueryClientProvider>);
    qc.clear();
    expect(html).toMatch(/<img class="thumb note-thumb" src="[^"]*sol\.jpg"/);
    expect(html).toMatch(/<img class="thumb note-thumb" src="[^"]*island\.jpg"/);
  });
});

describe("swap card pictures are looked up in batches", () => {
  it("keeps every search inside one page and the query limit", () => {
    const names = Array.from({ length: 130 }, (_, i) => `Card number ${i} with a fairly long name`);
    const batches = pictureBatches(names);
    expect(batches.flat()).toEqual(names);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(50);
      expect(b.map((n) => `!"${n}"`).join(" or ").length).toBeLessThanOrEqual(1000);
    }
    expect(batches.length).toBeLessThan(10);
  });
});
