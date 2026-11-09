import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./Profile";
import { SiteLinks } from "../components/SiteLinks";
import { RequireAccount } from "../components/RequireAccount";

vi.mock("./AccountSettings", () => ({ AccountSettings: () => <section>Account settings</section> }));
afterEach(() => vi.unstubAllGlobals());

function page({ user = "u1", handle = "saget", collection = true, wants = true, viewing = false }: { user?: string | null; handle?: string | null; collection?: boolean; wants?: boolean; viewing?: boolean } = {}) {
  vi.stubGlobal("location", { origin: "https://yama.ing" });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], user ? { id: user, display_name: "Bryan", email: "test@example.invalid", viewing: viewing ? {} : null } : null);
  client.setQueryData(["auth-config"], {});
  // Seed only the first account: switching accounts must not reuse its public links.
  client.setQueryData(["sharing", "u1"], { handle, collection_public: collection, wants_public: wants });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/profile"]}><SiteLinks /><Routes><Route element={<RequireAccount />}><Route path="profile" element={<ProfilePage />} /></Route></Routes></MemoryRouter></QueryClientProvider>);
  client.clear();
  return html;
}

describe("your profile", () => {
  it("makes personal pages and the public profile reachable without exposing private data in a URL", () => {
    const html = page();
    for (const path of ["/collection", "/decks/plans/get", "/decks", "/decks/plans", "/sharing", "/group"]) expect(html).toContain(`href="${path}"`);
    for (const path of ["/u/saget", "/u/saget/collection", "/u/saget/wants"]) expect(html).toContain(`href="https://yama.ing${path}" target="_blank"`);
    expect(html).toContain("View public profile");
    expect(html).toContain("Copy profile link");
    expect(html).toContain("My wish list");
    expect(html).toContain('aria-current="page" class="active" href="/profile"');
  });

  it("shows setup without a handle, and never links private collection or wishes", () => {
    const html = page({ handle: null });
    expect(html).toContain("Set up public profile");
    expect(html).toContain('href="/sharing#sharing"');
    expect(html).not.toContain("/u/");
    const privateLists = page({ collection: false, wants: false });
    expect(privateLists).toContain("View public profile");
    expect(privateLists).not.toContain("/u/saget/collection");
    expect(privateLists).not.toContain("/u/saget/wants");
  });

  it("doesn't render cached links for another account or while viewing as someone", () => {
    for (const options of [{ user: "u2" }, { viewing: true }]) {
      const html = page(options);
      expect(html).not.toContain("/u/saget");
      expect(html).not.toContain("View public profile");
    }
    expect(page({ user: "u2" })).toContain("Loading profile");
  });

  it("asks signed-out visitors to sign in, with no personal or cached public links", () => {
    const html = page({ user: null });
    expect(html).toContain("Sign in to see your cards");
    expect(html).not.toContain("/u/saget");
    expect(html).not.toContain("My collection");
  });
});
