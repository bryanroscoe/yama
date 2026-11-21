import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { historyView, PriceHistory, priceDay } from "./PriceHistory";

function history(state: "failed" | "empty" | "one") {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  if (state === "failed") client.getQueryCache().build(client, { queryKey: ["prices", "p1"] }).setState({ status: "error", fetchStatus: "idle", error: new Error("Server unavailable") });
  else client.setQueryData(["prices", "p1"], state === "one" ? [{ date: "2026-11-10", usd: 1.5, usd_foil: null, usd_etched: null }] : []);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PriceHistory scryfallId="p1" finish="nonfoil" setName="Commander Masters" />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("a printing's price history", () => {
  it("says the request failed, with a way to try again, instead of that no price is recorded", () => {
    const html = history("failed");
    expect(html).toContain("Couldn&#x27;t load the price history for Commander Masters: Server unavailable");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("No market price recorded");
  });

  it("says no price is recorded only when the server answered with none", () => {
    expect(history("empty")).toContain("No market price recorded for Commander Masters.");
    // The day as the rest of the app writes it, not the stored ISO date.
    expect(history("one")).toContain(`$1.50 on ${priceDay("2026-11-10")}`);
    expect(history("one")).not.toContain("2026-11-10");
  });

  it("writes a price's day short, with the year only when it isn't this year", () => {
    const now = new Date(2026, 10, 21);
    expect(priceDay("2026-11-20", now)).toBe("Nov 20");
    expect(priceDay("2025-12-31", now)).toBe("Dec 31, 2025");
    // Not a date: as given.
    expect(priceDay("soon", now)).toBe("soon");
  });

  it("keeps the failure on screen while it tries again", () => {
    const failed = new Error("Server unavailable");
    // Try again: the query reads as loading with no error for the length of the attempt.
    expect(historyView({ hasData: false, loading: true }, failed)).toBe("failed");
    expect(historyView({ hasData: false, loading: false }, failed)).toBe("failed");
    // First load: nothing yet. An answer: the prices.
    expect(historyView({ hasData: false, loading: true }, null)).toBe("wait");
    expect(historyView({ hasData: true, loading: false }, null)).toBe("show");
    expect(historyView({ hasData: true, loading: false }, failed)).toBe("show");
  });
});
