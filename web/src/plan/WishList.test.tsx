import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PlanBundle } from "@yama/core/plan";
import fixture from "../../../packages/core/src/plan/fixtures/trip.json";
import { planView } from "./view";
import { sameWant, wantReason } from "./Trip";
import { sharedText, WishListPage } from "./WishList";

const outlet = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./PlanLayout", () => ({ usePlanOutlet: () => outlet.value, PlanLayout: () => null, PlansHead: ({ title }: { title: string }) => <h1>{title}</h1> }));

/** The wish list page for an account, with `wants` on its list. */
function page(me: object, wants: object[], sharing?: object, listed?: number) {
  const b = {
    rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, orders: [], unresolved: [], cards: {},
    inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] },
    ...fixture.bundle,
    shopping_wants: wants,
  } as unknown as PlanBundle;
  outlet.value = { view: { ...planView(b), today: "2026-11-12" }, userId: "u1" };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], { id: "u1", email: "pat@example.com", display_name: "Pat", is_admin: false, ...me });
  client.setQueryData(["decks"], []);
  if (sharing) client.setQueryData(["sharing", "u1"], sharing);
  if (listed != null) client.setQueryData(["sharing-compare", "u1", "pat"], { handle: "pat", yourself: true, wants_public: true, collection_public: false, their_wants: listed, you_have: [], your_wants: listed, they_have: [] });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/collection/wishlist"]}>
        <WishListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

const want = { id: "w1", kind: "card", name: "Sol Ring", qty: 2, priority: "along", deck_id: null, deck_name: "Riders of Rohan", why: "For the new build", source: "owner" };

describe("Collection, Wish list", () => {
  it("shows the list with a way to add to it and take from it, for an account with Advanced off", () => {
    const html = page({ advanced: false }, [want]);
    expect(html).toContain("Wish list</h1>");
    expect(html).toContain("Sol Ring");
    expect(html).toContain("×2");
    expect(html).toContain("Only if you&#x27;re there anyway, for Riders of Rohan. For the new build.");
    expect(html).toContain("Remove");
    expect(html).toContain("Add to the wish list");
    // The store trip is a Workshop page: no way into it from here without Advanced.
    expect(html).not.toContain("/decks/plans");
  });

  it("starts empty with the form, and offers the store trip only with Advanced on", () => {
    const empty = page({ advanced: false }, []);
    expect(empty).toContain("Add to the wish list");
    expect(empty).not.toContain("Remove");
    expect(empty).toContain("Nothing on your wish list yet.");
    expect(page({ advanced: true }, [want])).toContain('href="/decks/plans/get/trip"');
  });
});

describe("the wish list's rows and form", () => {
  it("says a row's reason in one quiet line, with dates as the app writes them", () => {
    const now = new Date(2026, 10, 21);
    expect(wantReason({ kind: "card", priority: "need", deck_name: "Kraum & Tymna", why: "cEDH local buy (Pat's $ under rule, 2026-10-31)", source: "assistant", added_at: "2026-11-02T14:48:07Z" }, now)).toBe(
      "For Kraum & Tymna. cEDH local buy (Pat's $ under rule, Oct 31). Added by a change from Claude, Nov 2.",
    );
    expect(wantReason({ kind: "sealed", priority: "along", deck_name: null, why: null, source: "page", added_at: "2025-12-24T10:00:00Z" }, now)).toBe("Sealed product, only if you're there anyway. Added Dec 24, 2025.");
    expect(wantReason({ kind: "card", priority: "need", deck_name: null, why: null, source: "page" }, now)).toBe("");
  });

  it("lays a row out as the name, the reason under it and Remove", () => {
    const html = page({ advanced: false }, [want]);
    expect(html).toMatch(/<li class="wish-row"><span class="wish-row-text"><span class="wish-row-name">.*Sol Ring.*×2<\/span><\/span><span class="small dim">Only if/s);
    expect(html).toContain('aria-label="Remove Sol Ring from your wish list"');
  });

  it("asks how much it's wanted in plain words, and offers card names while typing", () => {
    const html = page({ advanced: false }, []);
    expect(html).toContain(">Want it</option>");
    expect(html).toContain(">Only if I&#x27;m there anyway</option>");
    for (const old of ["worth a trip", "along the way", "Worth a trip"]) expect(html).not.toContain(old);
    expect(html).toMatch(/<input[^>]*list="wish-card-names"/);
    expect(html).toContain('<datalist id="wish-card-names">');
  });

  it("finds a card already on the list for the same deck, whatever its capitals", () => {
    const rows = [{ kind: "card" as const, name: "Rhystic Study", deck_id: null }, { kind: "card" as const, name: "Sol Ring", deck_id: "d1" }];
    expect(sameWant(rows, "card", " rhystic study ", null)).toBe(rows[0]);
    // The same card for another deck, or as a sealed product, is its own row.
    expect(sameWant(rows, "card", "Sol Ring", null)).toBeUndefined();
    expect(sameWant(rows, "card", "Sol Ring", "d1")).toBe(rows[1]);
    expect(sameWant(rows, "sealed", "Rhystic Study", null)).toBeUndefined();
  });
});

describe("what friends see of the wish list", () => {
  it("says the public page holds more than the list", () => {
    expect(sharedText(6, 764)).toBe("Friends see these 6 plus the 758 cards your decks and plans still need.");
    expect(sharedText(1, 1)).toBe("Friends see this card.");
    expect(sharedText(0, 12)).toBe("Friends see the 12 cards your decks and plans still need.");
    expect(sharedText(0, 0)).toBe("Nothing is on it yet.");
    // Before the count is in, it still says the decks' cards are there.
    expect(sharedText(6, null)).toBe("Friends see these 6 and the cards your decks and plans still need.");
  });

  it("says whether it's shared, with the public page when it is and where to turn it on when it isn't", () => {
    vi.stubGlobal("location", { origin: "https://yama.ing" });
    const sharing = { handle: "pat", new_deck_visibility: "private", collection_public: false, wants_public: true, wants_include_pending: false, share_lab_results: false, public_listed_at: null, decks: { private: 0, link: 0, public: 0 } };
    const on = page({ advanced: false }, [want], sharing, 40);
    expect(on).toContain("Shared: on. Friends see this card plus the 39 cards your decks and plans still need.");
    expect(on).toMatch(/href="[^"]*\/u\/pat\/wants"[^>]*>Open the public page</);
    const off = page({ advanced: false }, [want], { ...sharing, wants_public: false });
    expect(off).toContain("Shared: off. Only you see this list.");
    expect(off).toContain('href="/sharing#sharing"');
    expect(off).not.toContain("/u/pat/wants");
    expect(page({ advanced: false }, [want], { ...sharing, handle: null })).toContain("choose a handle and turn on sharing your wish list");
    // Viewing as someone else, nothing about their sharing is read or shown.
    expect(page({ advanced: false, viewing: {} }, [want], sharing, 40)).not.toContain("Shared:");
    vi.unstubAllGlobals();
  });
});
