import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { ApiError, type DeckView } from "../api";
import { buildNotesKey } from "../research/api";
import { EditListPage } from "./EditListPage";

const entry = (name: string, board: "commander" | "main") => ({ oracle_id: name, name, qty: 1, board, card: null }) as unknown as DeckView["cards"][number];

/** `failed`: the deck's last request failed, with the deck already loaded ("refresh") or not ("load"). */
function page(failed?: "refresh" | "load" | "gone") {
  const deck = {
    id: "d1", name: "Alpha Deck", version_id: "v1", parent_id: null, configuration: null,
    configurations: [{ id: "d1", name: "Alpha Deck", configuration: null }],
    cards: [entry("Test Commander", "commander"), entry("Sol Ring", "main")],
  } as unknown as DeckView;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: !failed } } });
  client.setQueryData(["me"], { id: "u1" });
  client.setQueryData(["decks"], []);
  client.setQueryData(buildNotesKey("u1"), []);
  if (failed !== "load") client.setQueryData(["deck", "d1"], deck);
  if (failed) client.getQueryCache().build(client, { queryKey: ["deck", "d1"] }).setState({ status: "error", fetchStatus: "idle", error: failed === "gone" ? new ApiError(404, "No such deck") : new Error("Server unavailable") });
  // The editor asks before leaving with edits (unsaved.tsx), which needs a data router.
  const router = createMemoryRouter([{ path: "/decks/:id/edit", element: <EditListPage /> }], { initialEntries: ["/decks/d1/edit"] });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("Edit the list", () => {
  it("opens the editor on the deck", () => {
    const html = page();
    expect(html).toContain("<h1>Edit the list</h1>");
    expect(html).toContain("The list in the box");
    expect(html).not.toContain("Couldn&#x27;t refresh");
  });

  it("keeps the editor when a refresh of the deck fails, with a way to retry", () => {
    const html = page("refresh");
    expect(html).toContain("<h1>Edit the list</h1>");
    expect(html).toContain("<textarea");
    expect(html).toContain("Couldn&#x27;t refresh this deck: Server unavailable");
    expect(html).toContain(">Retry</button>");
  });

  it("shows the error with Try again when the deck never loaded", () => {
    const html = page("load");
    expect(html).not.toContain("Edit the list");
    expect(html).toContain("Server unavailable");
    expect(html).toContain(">Try again</button>");
  });

  it("doesn't keep a deck that was deleted elsewhere on screen", () => {
    const html = page("gone");
    expect(html).not.toContain("Edit the list");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("No such deck");
  });
});
