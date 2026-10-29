import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ComparePage } from "./Compare";

vi.mock("./LabLayout", () => ({ LabHead: () => null }));
vi.mock("./pickers", async (original) => ({ ...await original<typeof import("./pickers")>(), DeckChooser: () => null, EngineSupportNote: () => null }));

describe("tournament setup", () => {
  it("exposes a single field, bulk version selection, benchmarks and a per-deck budget", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}><MemoryRouter initialEntries={["/lab/compare?mode=tournament"]}><ComparePage /></MemoryRouter></QueryClientProvider>,
    );
    expect(html).toContain("Select all my saved decks");
    expect(html).toContain("Include all supported stock precons as tournament entrants");
    expect(html).toContain("Games per deck, per engine");
    expect(html).toContain("Start tournament");
    expect(html).not.toContain("every deck in each one");
    client.clear();
  });
});
