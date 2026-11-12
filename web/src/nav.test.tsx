import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabSections } from "./components/TabSections";
import { MAIN_TABS, TABS, sectionOf, sectionsFor, tab, tabOf, type Who } from "./nav";
// @ts-expect-error The polish tool's route reader is plain JavaScript with no types.
import { routesFromApp } from "../scripts/polish/routes.mjs";

// The Plans count reads the plan store and the offline outbox; neither matters to these pages.
vi.mock("./plan/store", () => ({ usePlan: () => ({ bundle: null }) }));
vi.mock("./plan/outbox", () => ({ outbox: { localOps: () => [] }, useOutbox: () => ({}) }));

afterEach(() => vi.unstubAllGlobals());

const guest: Who = { signedIn: false, power: false, evidence: false };
const account: Who = { ...guest, signedIn: true };
const owner: Who = { signedIn: true, power: true, evidence: true };

describe("the tabs", () => {
  it("are Play, Decks, Cards, Collection and Playgroup, with Workshop and You beside them", () => {
    expect(MAIN_TABS.map((id) => tab(id).label)).toEqual(["Play", "Decks", "Cards", "Collection", "Playgroup"]);
    expect(TABS.map((t) => t.label)).toEqual(["Play", "Decks", "Cards", "Collection", "Playgroup", "Workshop", "You"]);
    // The names Bryan chose (12 Nov 2026): Playgroup, not Group; Life counter, not Table.
    const words = TABS.flatMap((t) => [t.label, ...t.sections.map((s) => s.label)]);
    for (const old of ["Table", "Group", "Lab", "Sharing"]) expect(words).not.toContain(old);
    expect(words).toContain("Life counter");
  });

  it("each open on one of their own pages", () => {
    for (const t of TABS) expect(tabOf(t.to)?.id, t.label).toBe(t.id);
  });

  it("hold every address the app has had, old ones included", () => {
    const where: Record<string, string[]> = {
      play: ["/play/table", "/table", "/table/games", "/table/games/abc", "/play", "/play/watch", "/play/abc"],
      decks: ["/decks", "/decks/", "/decks/import", "/decks/changes", "/decks/abc", "/decks/abc/stats", "/decks/abc/edit", "/lab", "/lab/p/riders"],
      cards: ["/cards"],
      collection: ["/collection", "/collection/trade", "/sharing/compare/pat"],
      playgroup: ["/group", "/group/mythic", "/mythic/sent"],
      workshop: [
        "/decks/plans",
        "/decks/plans/get",
        "/decks/plans/get/trip",
        "/decks/plans/blight-curse",
        "/decks/plans/d/get",
        "/decks/plans/settings",
        "/decks/plans/archived/abc",
        "/decks/plan/trip",
        "/decks/research",
        "/decks/research/abc",
        "/decks/builds",
        "/lab/try",
        "/lab/compare",
        "/lab/runs",
        "/lab/runs/abc/decks/1",
        "/lab/runs/batch/abc",
        "/lab/datasets",
        "/lab/datasets/playgroup-history",
      ],
      you: ["/profile", "/sharing", "/new", "/admin", "/admin/usage"],
    };
    for (const [id, paths] of Object.entries(where)) for (const path of paths) expect(tabOf(path)?.id, path).toBe(id);
    // Home belongs to no tab: the wordmark goes there.
    expect(tabOf("/")).toBeNull();
    expect(tabOf("/nowhere")).toBeNull();
    // A page whose name only starts like a tab's isn't under it.
    expect(tabOf("/decksx")).toBeNull();
    expect(tabOf("/labs")).toBeNull();
  });

  it("hold every route the app has: a new page says which tab it belongs to", () => {
    // Pages with no tab: Home (the wordmark goes there), and the sign-in and consent pages and
    // the full-screen life counter and online board, which draw no frame. Add a route to a tab
    // in nav.tsx, not to this list.
    const frameless = ["/", "/signin", "/oauth/authorize", "/table/play", "/table/join/:gameId", "/play/:id", "/play/watch/:id"];
    const routes = (routesFromApp(readFileSync(new URL("./App.tsx", import.meta.url), "utf8")) as string[]).filter((r) => !frameless.includes(r));
    expect(routes.length).toBeGreaterThan(40);
    const tabless = routes.filter((r) => !tabOf(r.replace(/:\w+/g, "x")));
    expect(tabless).toEqual([]);
  });

  it("list a section only for the people it is for", () => {
    const labels = (id: Parameters<typeof tab>[0], who: Who) => sectionsFor(tab(id), who).map((s) => s.label);
    expect(labels("play", guest)).toEqual(["Life counter", "Play online"]);
    // Every account may watch the computer play and start a simulation, power user or not.
    expect(labels("play", account)).toEqual(["Life counter", "Play online", "Watch", "Game history"]);
    expect(labels("play", owner)).toEqual(["Life counter", "Play online", "Watch", "Game history"]);
    expect(labels("workshop", account)).toEqual(["Plans", "Get the cards", "Swap cards", "Try a change", "Compare decks", "Lab runs"]);
    expect(labels("workshop", { ...account, evidence: true })).toContain("Datasets");
    expect(labels("workshop", owner)).toEqual(["Plans", "Get the cards", "Swap cards", "Try a change", "Compare decks", "Lab runs", "Datasets"]);
    // Precons is the account's own table signed in and the public reference signed out.
    expect(sectionsFor(tab("decks"), account).map((s) => s.to)).toEqual(["/decks", "/lab", "/commanders"]);
    expect(sectionsFor(tab("decks"), guest).map((s) => s.to)).toEqual(["/decks", "/precons", "/commanders"]);
  });

  it("know which of a tab's pages a page is, and that a deck or a plan's own page is none of them", () => {
    const at = (path: string, who = owner) => sectionOf(tabOf(path)!, path, who)?.label ?? null;
    expect(at("/play/table")).toBe("Life counter");
    expect(at("/play")).toBe("Play online");
    expect(at("/play/watch")).toBe("Watch");
    expect(at("/table/games/abc")).toBe("Game history");
    expect(at("/decks")).toBe("My decks");
    expect(at("/decks/import")).toBe("My decks");
    expect(at("/decks/abc")).toBeNull();
    expect(at("/lab/p/riders")).toBe("Precons");
    expect(at("/decks/plans")).toBe("Plans");
    expect(at("/decks/plans/archived/abc")).toBe("Plans");
    expect(at("/decks/research/abc")).toBe("Plans");
    expect(at("/decks/plans/blight-curse")).toBeNull();
    expect(at("/decks/plans/get/trip")).toBe("Get the cards");
    expect(at("/lab/runs/abc")).toBe("Lab runs");
    expect(at("/sharing/compare/pat")).toBe("Trade with a friend");
    // Not for this account: the page still belongs to the tab, with no entry to mark.
    expect(at("/lab/datasets", account)).toBeNull();
    // Every account may start a simulation, so its pages are entries for everyone.
    expect(at("/lab/try", account)).toBe("Try a change");
    expect(at("/play/watch", account)).toBe("Watch");
  });
});

/** The strip at `path` for `me`, with `owned` as the account's datasets. */
function strip(path: string, me: { id: string; power?: boolean; is_admin?: boolean } | null = { id: "u1" }, owned: unknown[] = []) {
  vi.stubGlobal("location", { origin: "https://yama.ing" });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], me);
  if (me) client.setQueryData(["datasets", me.id], owned);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><TabSections /></MemoryRouter></QueryClientProvider>);
  client.clear();
  return html;
}
const current = (html: string) => [...html.matchAll(/<a [^>]*aria-current="(?:page|true)"[^>]*href="([^"]+)"/g)].map((m) => m[1] ?? "");
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");

describe("the strip of a tab's pages", () => {
  it("marks exactly one page current on every page that shows it", () => {
    expect(current(strip("/play/table"))).toEqual(["/play/table"]);
    expect(current(strip("/play"))).toEqual(["/play"]);
    expect(current(strip("/table/games"))).toEqual(["/table/games"]);
    expect(current(strip("/decks"))).toEqual(["/decks"]);
    expect(current(strip("/decks/import"))).toEqual(["/decks"]);
    expect(current(strip("/decks/changes"))).toEqual(["/decks"]);
    expect(current(strip("/lab/p/riders"))).toEqual(["/lab"]);
    expect(current(strip("/decks/builds"))).toEqual(["/decks/builds"]);
    expect(current(strip("/decks/plan/trip"))).toEqual(["/decks/plans"]);
    expect(current(strip("/decks/plans/archived/abc"))).toEqual(["/decks/plans"]);
    expect(current(strip("/decks/plans/get/sourcing"))).toEqual(["/decks/plans/get"]);
    expect(current(strip("/collection/trade"))).toEqual(["/collection/trade"]);
  });

  it("calls only an entry's own address the current page; a page under it marks the place", () => {
    expect(strip("/lab/runs")).toMatch(/aria-current="page"[^>]*href="\/lab\/runs"/);
    expect(strip("/lab/runs/abc")).toMatch(/aria-current="true"[^>]*href="\/lab\/runs"/);
    expect(strip("/decks/import")).toMatch(/aria-current="true"[^>]*href="\/decks"/);
  });

  it("stays off a page that has its own way back, and off tabs with one page", () => {
    for (const path of ["/", "/decks/abc", "/decks/abc/stats", "/decks/plans/blight-curse", "/cards", "/group", "/profile", "/sharing", "/admin", "/nowhere"]) expect(strip(path), path).toBe("");
  });

  it("lists the Workshop's simulation pages for every account, and Datasets for accounts that have one", () => {
    const plain = links(strip("/lab/runs"));
    expect(plain).toEqual(["/decks/plans", "/decks/plans/get", "/decks/builds", "/lab/try", "/lab/compare", "/lab/runs"]);
    expect(links(strip("/lab/runs", { id: "u1", power: true }))).toEqual(plain);
    expect(links(strip("/lab/runs", { id: "u1" }, [{ id: "playgroup-history" }]))).toContain("/lab/datasets");
    expect(links(strip("/lab/runs", { id: "u1", power: true, is_admin: true }))).toContain("/lab/datasets");
    // The Datasets page lists itself while open, whoever is looking, so the strip never comes
    // and goes there while the account's datasets are still being asked for.
    expect(current(strip("/lab/datasets"))).toEqual(["/lab/datasets"]);
    expect(current(strip("/lab/datasets/playgroup-history"))).toEqual(["/lab/datasets"]);
  });

  it("gives someone signed out the public precon and commander pages as document links", () => {
    const html = strip("/decks", null);
    expect(links(html)).toEqual(["/decks", "https://yama.ing/precons", "https://yama.ing/commanders"]);
    expect(links(strip("/decks"))).toEqual(["/decks", "/lab", "https://yama.ing/commanders"]);
    expect(links(strip("/play/table", null))).toEqual(["/play/table", "/play"]);
  });

  it("says online play is in alpha where it is reached", () => {
    const html = strip("/play/table");
    expect(html).toMatch(/href="\/play"[^>]*>Play online<span[^>]*alpha-tag/);
    expect(html.match(/alpha-tag/g)).toHaveLength(1);
  });
});
