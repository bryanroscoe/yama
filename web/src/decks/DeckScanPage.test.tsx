import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { DeckView } from "../api";
import { DeckScanPage } from "./DeckScanPage";

const entry = (name: string, board: "commander" | "main") => ({ oracle_id: name, name, qty: 1, board }) as unknown as DeckView["cards"][number];

/** `failed`: the deck's last request failed, with the deck already loaded ("refresh") or not ("load"). */
function page(failed?: "refresh" | "load") {
  const deck = { id: "d1", name: "Alpha Deck", cards: [entry("Test Commander", "commander"), entry("Sol Ring", "main")] } as unknown as DeckView;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: !failed } } });
  if (failed !== "load") client.setQueryData(["deck", "d1"], deck);
  if (failed) client.getQueryCache().build(client, { queryKey: ["deck", "d1"] }).setState({ status: "error", fetchStatus: "idle", error: new Error("Server unavailable") });
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

  it("keeps the scan on screen when a refresh of the deck fails, with a way to retry", () => {
    const html = page("refresh");
    expect(html).toContain("Scan Alpha Deck");
    expect(html).toContain("Scan with the camera");
    expect(html).toContain("Couldn&#x27;t refresh this deck: Server unavailable");
    expect(html).toContain(">Retry</button>");
  });

  it("shows the error with Try again when the deck never loaded", () => {
    const html = page("load");
    expect(html).not.toContain("Scan Alpha Deck");
    expect(html).toContain("Server unavailable");
    expect(html).toContain(">Try again</button>");
  });
});
