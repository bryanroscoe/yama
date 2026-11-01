import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeckView } from "../api";
import { DeckCheckPage } from "./DeckCheckPage";

const entry = (name: string, board: "commander" | "main", qty = 1, owned = 1) =>
  ({ oracle_id: name, name, qty, board, owned, proxies: 0, locations: owned ? { "Prismari box": owned } : {} }) as unknown as DeckView["cards"][number];

function page(saved?: object) {
  const mem = new Map<string, string>();
  if (saved) mem.set("yama.deckCheck.d1", JSON.stringify(saved));
  vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  const deck = {
    id: "d1", name: "Prismari Artistry", version_id: "v2", parent_id: null, configuration: null, configurations: [],
    cards: [entry("Rootha, Mastering the Moment", "commander"), entry("Sol Ring", "main"), entry("Ancient Tomb", "main"), entry("Island", "main", 2)],
  } as unknown as DeckView;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], { id: "u1" });
  client.setQueryData(["deck", "d1"], deck);
  client.setQueryData(["decks"], [{ id: "d1", name: "Prismari Artistry", parent_id: null, configuration: null, bracket: 4, updated_at: "2026-10-31T00:00:00Z" }]);
  client.setQueryData(["research", "u1", "list"], []);
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
  it("starts against the deck's current list and offers its versions and plan builds", () => {
    const html = page();
    expect(html).toContain("Check Prismari Artistry");
    expect(html).toContain("Nothing is saved");
    expect(html).toMatch(/<optgroup label="This deck"><option value="current"[^>]*>The deck&#x27;s current list<\/option>/);
    expect(html).toContain("Stock, Oct 20, 2026");
    expect(html).not.toContain("Installed, Oct 31");
    expect(html).toContain(">Plan: after prints<");
    expect(html).toContain(">Plan: [3] Plan<");
    expect(html).toContain(">0</b> checked");
    expect(html).toContain("0 of 5 belong");
    expect(html).toContain("Check with the camera");
    expect(html).toContain("Mute.");
    expect(html).toContain("No cards checked yet.");
  });

  it("shows the newest card's verdict, what to take out with its replacement, and what's still missing", () => {
    const html = page({
      v: 1, deckId: "d1", commanders: ["Rootha, Mastering the Moment"], target: "plan:prismari:b3",
      cards: [card("k0", "Sol Ring", 1), card("k1", "Ancient Tomb", 2), card("k2", "Sol Ring", 3), card("k3", "Island", 4), card("k4", "Island", 5), card("k5", "Island", 6)],
    });
    // The Bracket 3 build swaps Ancient Tomb for Reliquary Tower.
    expect(html).toMatch(/<option value="plan:prismari:b3" selected="">Plan: \[3\] Plan<\/option>/);
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

  it("falls back to the current list when the saved target is gone", () => {
    const html = page({ v: 1, deckId: "d1", commanders: [], target: "research:gone:x:y", cards: [card("k0", "Sol Ring", 1)] });
    expect(html).toContain("isn&#x27;t there any more");
    expect(html).toContain("deck-check-verdict is-good");
  });
});
