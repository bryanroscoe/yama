import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriceHistory } from "./PriceHistory";

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
    expect(history("one")).toContain("$1.50 on 2026-11-10");
  });
});
