import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { DeckView } from "../api";
import { DeckScanPage } from "./DeckScanPage";

const entry = (name: string, board: "commander" | "main") => ({ oracle_id: name, name, qty: 1, board }) as unknown as DeckView["cards"][number];

function page() {
  const deck = { id: "d1", name: "Alpha Deck", cards: [entry("Test Commander", "commander"), entry("Sol Ring", "main")] } as unknown as DeckView;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["deck", "d1"], deck);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/decks/d1/scan"]}>
        <Routes>
          <Route path="/decks/:id/scan" element={<DeckScanPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("Scan this deck", () => {
  it("starts with the count toward 100, the deck's commander and the ways to add a card", () => {
    const html = page();
    expect(html).toContain("Scan Alpha Deck");
    expect(html).toContain(">0</b> of 100 cards");
    expect(html).toContain("Commander Test Commander: not scanned yet.");
    expect(html).toContain("Add Test Commander without scanning");
    expect(html).toContain("Scan with the camera");
    expect(html).toContain("Or type a card&#x27;s name");
    expect(html).toContain("earlier versions stay in History");
    // Nothing to compare until a card is in.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check the changes<\/button>/);
  });
});
