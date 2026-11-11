import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeckView } from "../api";
import { DeckCheckPage } from "./DeckCheckPage";
import { buildNotesKey } from "../research/api";

const entry = (name: string, board: "commander" | "main", qty = 1, owned = 1) =>
  ({ oracle_id: name, name, qty, board, owned, proxies: 0, locations: owned ? { "Prismari box": owned } : {} }) as unknown as DeckView["cards"][number];

/** `research`: the notes' builds; null leaves them still loading. */
function page(saved?: object, research?: object[] | null, { decksFail = false, deckRefreshFails = false } = {}) {
  const mem = new Map<string, string>();
  if (saved) mem.set("yama.deckCheck.d1", JSON.stringify(saved));
  vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  const deck = {
    id: "d1", name: "Prismari Artistry", version_id: "v2", parent_id: null, configuration: null, configurations: [],
    cards: [entry("Rootha, Mastering the Moment", "commander"), entry("Sol Ring", "main"), entry("Ancient Tomb", "main"), entry("Island", "main", 2)],
  } as unknown as DeckView;
  // A failed query stays failed on render (no refetch on mount), as after a real failure.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: !decksFail && !deckRefreshFails } } });
  client.setQueryData(["me"], { id: "u1" });
  client.setQueryData(["deck", "d1"], deck);
  // The deck is on screen and its background refresh failed.
  if (deckRefreshFails) client.getQueryCache().build(client, { queryKey: ["deck", "d1"] }).setState({ status: "error", fetchStatus: "idle", error: new Error("Server unavailable") });
  if (decksFail) client.getQueryCache().build(client, { queryKey: ["decks"] }).setState({ status: "error", fetchStatus: "idle", error: new Error("Server unavailable") });
  else client.setQueryData(["decks"], [{ id: "d1", name: "Prismari Artistry", parent_id: null, configuration: null, bracket: 4, updated_at: "2026-10-31T00:00:00Z" }]);
  if (research !== null) client.setQueryData(buildNotesKey("u1"), research ?? []);
  client.setQueryData(["deck-versions", "d1", "v2"], [{ id: "v2", note: "Installed", created_at: "2026-10-31T10:00:00Z" }, { id: "v1", note: "Stock", created_at: "2026-10-20T10:00:00Z" }]);
  client.setQueryData(["plan", "u1"], {
    orders: [], stores: [], head: { guide_version: 28 },
    decks: [{
      key: "prismari", name: "Prismari Artistry", deck_id: "d1", status: "active", owner_changes: [],
      bracket: { target: 4, bags: { "3": [{ out: "Ancient Tomb", in: "Reliquary Tower", got: { how: "deck", deck: null, deck_name: "Spares", origin: "bought" } }] } },
      states: { after: { id: "a", content_hash: "", computed_by: "", updated_at: "2026-10-31T00:00:00Z", log: [], unresolved: [], cards: [
        { name: "Rootha, Mastering the Moment", qty: 1, board: "commander" }, { name: "Sol Ring", qty: 1, board: "main" }, { name: "Ancient Tomb", qty: 1, board: "main" }, { name: "Island", qty: 2, board: "main" },
      ] } },
    }],
    swaps: [],
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/decks/d1/check"]}>
        <Routes>
          <Route path="/decks/:id/check" element={<DeckCheckPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

afterEach(() => vi.unstubAllGlobals());

const card = (key: string, name: string, at: number) => ({ key, name, at });

describe("Check this deck", () => {
  it("keeps the check on screen when a refresh of the deck fails, with a way to retry", () => {
    const html = page(undefined, [], { deckRefreshFails: true });
    expect(html).toContain("Check Prismari Artistry");
    expect(html).toContain("Check with the camera");
    expect(html).toContain("Couldn&#x27;t refresh this deck: Server unavailable");
    expect(html).toContain(">Retry</button>");
  });

  it("starts against the deck's current list and offers its versions and plan builds", () => {
    const html = page();
    expect(html).toContain("Check Prismari Artistry");
    expect(html).toContain("Checking doesn&#x27;t change your deck or collection");
    expect(html).toMatch(/<optgroup label="This deck"><option value="current"[^>]*>The deck&#x27;s current list<\/option>/);
    expect(html).toContain("Stock, Oct 20, 2026");
    expect(html).not.toContain("Installed, Oct 31");
    expect(html).toContain(">Plan: after prints<");
    expect(html).toContain(">Plan: Bracket 3<");
    expect(html).toContain(">0</b> checked");
    expect(html).toContain("0 of 5 belong");
    expect(html).toContain("Check with the camera");
    expect(html).toContain("Mute sounds and vibration");
    expect(html).toContain("No cards checked yet.");
  });

  it("shows the newest card's verdict, what to take out with its replacement, and what's still missing", () => {
    const html = page({
      v: 1, deckId: "d1", commanders: ["Rootha, Mastering the Moment"], target: "plan:prismari:b3",
      cards: [card("k0", "Sol Ring", 1), card("k1", "Ancient Tomb", 2), card("k2", "Sol Ring", 3), card("k3", "Island", 4), card("k4", "Island", 5), card("k5", "Island", 6)],
    });
    // The Bracket 3 build swaps Ancient Tomb for Reliquary Tower.
    expect(html).toMatch(/<option value="plan:prismari:b3" selected="">Plan: Bracket 3<\/option>/);
    expect(html).toContain("deck-check-verdict is-out");
    expect(html).toContain("One too many: the list has 2.");
    expect(html).toContain("3 of 5 belong");
    expect(html).toContain("3 to take out");
    expect(html).toContain("Take out: 3");
    expect(html).toMatch(/Ancient Tomb[\s\S]*Put in <b>Reliquary Tower<\/b> instead\./);
    expect(html).toContain("second copy");
    expect(html).toContain("Still missing: 2");
    expect(html).toContain("Goes in for Ancient Tomb.");
    expect(html).toContain("Save as a deck scan");
  });

  it("waits for a saved research target to load rather than check against the wrong list", () => {
    const html = page(
      { v: 1, deckId: "d1", commanders: [], target: "research:r1:prismari-artistry:b2-owned-now", cards: [card("k0", "Ancient Tomb", 1)] },
      null,
    );
    expect(html).toContain("Loading the list this check was against…");
    expect(html).toContain("Loading the list…");
    expect(html).not.toContain("deck-check-verdict");
    expect(html).not.toContain("Check with the camera");
  });

  it("falls back to the current list when the saved target is gone", () => {
    const html = page({ v: 1, deckId: "d1", commanders: [], target: "research:gone:x:y", cards: [card("k0", "Sol Ring", 1)] });
    expect(html).toContain("isn&#x27;t there any more");
    expect(html).toContain("deck-check-verdict is-good");
  });

  it("says the saved target couldn't be loaded, not that it's gone, when the deck list fails", () => {
    const html = page({ v: 1, deckId: "d1", commanders: [], target: "research:gone:x:y", cards: [card("k0", "Sol Ring", 1)] }, undefined, { decksFail: true });
    expect(html).toContain("couldn&#x27;t be loaded");
    expect(html).not.toContain("isn&#x27;t there any more");
  });
});
