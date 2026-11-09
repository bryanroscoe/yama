import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteLinks } from "../components/SiteLinks";
import { RequireAccount } from "../components/RequireAccount";
import { ComparePage, SharingPage } from "./Sharing";

// The Plans count reads the plan store and the offline outbox; neither matters to these pages.
vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));
vi.mock("../plan/outbox", () => ({ outbox: { localOps: () => [] }, useOutbox: () => ({}) }));

afterEach(() => vi.unstubAllGlobals());

function page(me: { id: string; viewing?: object } | null = { id: "u1" }, empty = false, handle: string | null = "saget", wantsPublic = false) {
  vi.stubGlobal("location", { origin: "https://yama.ing" });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], me);
  client.setQueryData(["auth-config"], {});
  client.setQueryData(["sharing", "u1"], { handle, new_deck_visibility: "private", collection_public: true, wants_public: wantsPublic, share_lab_results: false, decks: { private: 1, link: 1, public: 1 } });
  client.setQueryData(["decks", "u1"], empty ? [] : [
    { id: "main", name: "Rohan", visibility: "public", share_token: "main-token" },
    { id: "alt", name: "Rohan", configuration: "Bracket 3", parent_id: "main", visibility: "link", share_token: "alt-token" },
    { id: "private", name: "Private deck", visibility: "private", share_token: "private-token" },
  ]);
  client.setQueryData(["research", me?.id, "list"], empty ? [] : [
    { id: "build/group", title: "Friday builds", visibility: "link", share_token: "build-token" },
    { id: "public", title: "Public builds", visibility: "public", share_token: "public-token" },
    { id: "private", title: "Private note", visibility: "private", share_token: "secret-token" },
  ]);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/sharing"]}><SiteLinks /><Routes><Route element={<RequireAccount />}><Route path="sharing" element={<SharingPage />} /></Route></Routes></MemoryRouter></QueryClientProvider>);
  client.clear();
  return html;
}

describe("returning to shared content", () => {
  it("links every shared configuration and build group to both its public page and editor", () => {
    const html = page();
    for (const path of ["/d/main-token", "/d/alt-token", "/r/build-token", "/r/public-token", "/u/saget"]) expect(html).toContain(`href="https://yama.ing${path}"`);
    for (const path of ["/decks/main", "/decks/alt", "/decks/research/build%2Fgroup"]) expect(html).toContain(`href="${path}"`);
    expect(html).toContain("Friday builds");
    expect(html).toContain("Bracket 3");
    expect(html).not.toContain("Private deck");
    expect(html).not.toContain("Private note");
    expect(html).not.toContain("secret-token");
  });

  it("keeps public pages as document links and marks Sharing current", () => {
    const html = page();
    expect(html).toContain('aria-current="page" class="active" href="/sharing"');
    for (const path of ["/precons", "/commanders"]) expect(html).toContain(`href="https://yama.ing${path}"`);
  });

  it("keeps the Decks sections control, with Sharing chosen", () => {
    const html = page();
    expect(html).toContain('aria-label="Decks sections"');
    const sections = html.slice(html.indexOf('aria-label="Decks sections"'));
    expect(sections.slice(0, sections.indexOf("</nav>"))).toMatch(/aria-current="page"[^>]*href="\/sharing"/);
    expect(html).toContain('href="/decks/builds"');
  });

  it("explains where to start when nothing is shared", () => {
    const html = page({ id: "u1" }, true);
    expect(html).toContain("No decks shared yet");
    expect(html).toContain("No plans shared yet");
    expect(html).toContain('href="/decks/plans"');
  });

  it("offers handle setup when there is no public profile yet", () => {
    const html = page({ id: "u1" }, false, null);
    expect(html).toContain("Choose a handle");
    expect(html).toContain('href="#sharing"');
    expect(html).not.toContain("Open my public profile");
    expect(html).toContain("Friday builds");
  });

  it("does not reuse another account's profile or settings after an expired session", () => {
    const html = page({ id: "u2" });
    expect(html).not.toContain("/u/saget");
    expect(html).not.toContain("Open my public profile");
    expect(html).toContain("Loading profile");
    expect(html).not.toContain('value="saget"');
    expect(html).not.toContain("Rohan");
    expect(html).not.toContain("main-token");
    expect(html).not.toContain("alt-token");
  });

  it("hides cached shared content when signed out or viewing another account", () => {
    for (const me of [null, { id: "u1", viewing: {} }]) {
      const html = page(me);
      expect(html).not.toContain("Friday builds");
      expect(html).not.toContain("main-token");
      expect(html).not.toContain("/u/saget");
    }
    expect(page(null)).toContain("Sign in to Yama");
  });
});

describe("trading with friends", () => {
  it("links the want list once it's on the profile, and says how to turn it on before", () => {
    const on = page({ id: "u1" }, false, "saget", true);
    expect(on).toContain('href="https://yama.ing/u/saget/wants"');
    expect(on).toContain("Copy want list link");
    expect(on).toContain("Public decks, public plans, what you&#x27;re looking for and your collection appear here.");
    const off = page();
    expect(off).not.toContain("/u/saget/wants");
    expect(off).toContain("Show what I&#x27;m looking for on my profile");
    expect(off).toContain("Compare with a friend");
    expect(page({ id: "u1" }, false, null)).toContain("choose a handle and turn on");
  });

  function compare(data: object) {
    vi.stubGlobal("location", { origin: "https://yama.ing" });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(["me"], { id: "u1" });
    client.setQueryData(["auth-config"], {});
    client.setQueryData(["sharing-compare", "u1", "pal"], data);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/sharing/compare/pal"]}><Routes><Route path="sharing/compare/:handle" element={<ComparePage />} /></Routes></MemoryRouter></QueryClientProvider>);
    client.clear();
    return html;
  }

  it("shows both directions, with copies, printings and dated market prices", () => {
    const html = compare({
      handle: "pal", yourself: false, wants_public: true, collection_public: true, their_wants: 4, your_wants: 3,
      you_have: [{ name: "Sol Ring", qty: 2, needed: true, image: null, type_line: "Artifact", market: 1.5, market_date: "2026-11-07", copies: 3, in_decks: 1 }],
      they_have: [{ name: "Command Tower", qty: 1, needed: false, image: null, type_line: "Land", market: null, market_date: null, copies: 1, printings: [{ set_code: "cmm", set_name: "Commander Masters", collector_number: "1000", finish: "foil", lang: "en", condition: "NM", qty: 1 }] }],
    });
    expect(html).toContain("@pal is looking for, you have");
    expect(html).toContain("You have 3, 1 in deck boxes");
    expect(html).toContain("$1.50 market, 7 Nov 2026");
    expect(html).toContain("About $3.00 at market.");
    expect(html).toContain("They have 1: 1 CMM 1000 foil, NM");
    expect(html).toContain("No market price");
    expect(html).not.toContain("$0.00");
    expect(html).toContain('href="https://yama.ing/u/pal/wants"');
  });

  it("asks a signed-out friend to sign in to compare", () => {
    vi.stubGlobal("location", { origin: "https://yama.ing" });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(["me"], null);
    client.setQueryData(["auth-config"], {});
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/sharing/compare/pal"]}><Routes><Route element={<RequireAccount />}><Route path="sharing/compare/:handle" element={<ComparePage />} /></Route></Routes></MemoryRouter></QueryClientProvider>);
    client.clear();
    expect(html).toContain("Compare collections");
    expect(html).toContain("Sign in to see which of a friend");
  });

  it("says what a friend doesn't share", () => {
    const html = compare({ handle: "pal", yourself: false, wants_public: false, collection_public: false, their_wants: 0, your_wants: 3, you_have: [], they_have: [] });
    expect(html).toContain("@pal doesn&#x27;t share a want list.");
    expect(html).toContain("@pal doesn&#x27;t share a collection");
    expect(html).not.toContain("/u/pal/wants");
  });
});
