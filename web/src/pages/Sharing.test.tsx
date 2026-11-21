import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireAccount } from "../components/RequireAccount";
import { ApiError } from "../api";
import { ComparePage, priceDay, SharingPage, TradePage } from "./Sharing";

// The Plans count reads the plan store and the offline outbox; neither matters to these pages.
vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));
vi.mock("../plan/outbox", () => ({ outbox: { localOps: () => [] }, useOutbox: () => ({}) }));

afterEach(() => vi.unstubAllGlobals());

function page(me: { id: string; viewing?: object } | null = { id: "u1" }, empty = false, handle: string | null = "saget", wantsPublic = false, path = "/sharing") {
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
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route element={<RequireAccount />}><Route path="sharing" element={<SharingPage />} /><Route path="collection/trade" element={<TradePage />} /></Route></Routes></MemoryRouter></QueryClientProvider>);
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

  it("is You's Sharing settings: a way back to You, and no trading or Decks control of its own", () => {
    const html = page();
    expect(html).toContain("<h1 class=\"area-title\">Sharing settings</h1>");
    expect(html).toContain('href="/profile"');
    expect(html).not.toContain("Decks sections");
    expect(html).not.toContain("Compare with a friend");
    expect(html).not.toContain('href="/decks/builds"');
  });

  it("explains where to start when nothing is shared", () => {
    const html = page({ id: "u1" }, true);
    expect(html).toContain("No decks shared yet");
    expect(html).toContain("No plans shared yet");
    expect(html).toContain('href="/decks/plans"');
  });

  it("offers handle setup when there is no public profile yet", () => {
    const html = page({ id: "u1" }, false, null);
    // The handle is chosen on this page: the sentence points down it, not at "Sharing settings".
    expect(html).toContain('<a href="#sharing">Choose a handle below</a> to give your public pages a profile.');
    expect(html).not.toContain("Choose a handle in");
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
  it("links the wish list once it's on the profile, and says how to turn it on before", () => {
    const trade = (handle: string | null = "saget", wantsPublic = false, me: { id: string; viewing?: object } | null = { id: "u1" }) => page(me, false, handle, wantsPublic, "/collection/trade");
    const on = trade("saget", true);
    expect(on).toContain("<h1 class=\"area-title\">Trade with a friend</h1>");
    expect(on).toContain('href="https://yama.ing/u/saget/wants"');
    expect(on).toContain("Copy wish list link");
    // What friends see is said as it is: the wish list and what the decks still need.
    expect(on).toContain("together with the cards your decks and plans still need");
    expect(page({ id: "u1" }, false, "saget", true)).toContain("Public decks, public plans, your wish list and your collection appear here.");
    const off = trade();
    expect(off).not.toContain("/u/saget/wants");
    expect(off).toContain("To share your wish list with friends, turn on sharing it in");
    expect(off).toContain('href="/sharing#sharing"');
    expect(off).toContain("Compare with a friend");
    expect(trade(null)).toContain("choose a handle and turn on");
    // One name for the list on this page.
    for (const html of [on, off]) for (const other of ["want list", "shopping list", "looking for"]) expect(html).not.toContain(other);
    // Another account's cached want list never shows, nor while an admin views as someone.
    for (const me of [{ id: "u2" }, { id: "u1", viewing: {} }]) expect(trade("saget", true, me)).not.toContain("/u/saget");
    expect(trade("saget", true, null)).toContain("Sign in to see which of a friend");
  });

  it("says how a friend gets involved: your handle, and the three steps both of you take", () => {
    const trade = (handle: string | null, wantsPublic = false) => page({ id: "u1" }, false, handle, wantsPublic, "/collection/trade");
    const mine = trade("saget", true);
    expect(mine).toContain("Your handle: <b>@saget</b>. You share your wish list and your collection.");
    expect(trade("saget")).toContain("You share your collection, not your wish list.");
    for (const step of ["You both pick a handle in", "You both turn on sharing there: your wish list, your collection, or both.", "Type their handle here."]) expect(mine).toContain(step);
    const none = trade(null);
    expect(none).toContain("You don&#x27;t have a handle yet.");
    expect(none).toMatch(/<a href="\/sharing#sharing"[^>]*>Choose a handle<\/a>/);
    expect(none).not.toContain("Your handle:");
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
    expect(html).toContain("@pal wants, you have");
    expect(html).toContain("You want, @pal has");
    expect(html).toContain("You have 3, 1 in deck boxes");
    // Dated the way the rest of the app dates a price: no year while it is this year.
    expect(html).toContain(`$1.50 market, ${priceDay("2026-11-07")}`);
    expect(priceDay("2026-11-07", new Date(2026, 10, 21))).toBe("Nov 7");
    expect(priceDay("2025-11-07T10:00:00Z", new Date(2026, 10, 21))).toBe("Nov 7, 2025");
    expect(html).toContain("1 of the 4 cards on their wish list.");
    expect(html).toContain("About $3.00 at market.");
    expect(html).toContain("They have 1: 1 CMM 1000 foil, NM");
    expect(html).toContain("No price");
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
    expect(html).toContain("@pal doesn&#x27;t share a wish list.");
    expect(html).toContain("@pal doesn&#x27;t share a collection");
    expect(html).not.toContain("/u/pal/wants");
  });

  it("counts a list of one as one card", () => {
    const html = compare({ handle: "pal", yourself: false, wants_public: true, collection_public: true, their_wants: 1, your_wants: 1, you_have: [], they_have: [] });
    expect(html).toContain("The one card on their wish list isn&#x27;t in your collection.");
    expect(html).toContain("The one card on your wish list isn&#x27;t in their collection.");
    expect(html).not.toContain("None of the 1 cards");
    const many = compare({ handle: "pal", yourself: false, wants_public: true, collection_public: true, their_wants: 764, your_wants: 2, you_have: [], they_have: [] });
    expect(many).toContain("None of the 764 cards on their wish list are in your collection.");
  });

  it("says in plain words that nobody has a handle", () => {
    vi.stubGlobal("location", { origin: "https://yama.ing" });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
    client.setQueryData(["me"], { id: "u1" });
    client.setQueryData(["auth-config"], {});
    // The server's answer for a handle nobody has, as the query keeps it.
    const key = ["sharing-compare", "u1", "nobody"];
    client.getQueryCache().build(client, { queryKey: key }).setState({ status: "error", error: new ApiError(404, "profile not found"), fetchStatus: "idle" });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/sharing/compare/nobody"]}><Routes><Route path="sharing/compare/:handle" element={<ComparePage />} /></Routes></MemoryRouter></QueryClientProvider>);
    client.clear();
    expect(html).toContain("No one on Yama has the handle @nobody.");
    expect(html).not.toContain("profile not found");
    expect(html).not.toContain("Cards you could trade");
    expect(html).toContain('href="/collection/trade"');
  });
});
