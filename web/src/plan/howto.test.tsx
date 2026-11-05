import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { BuyHowTo, ChangesHowTo, ReviewHowTo, TripHowTo } from "./howto";

vi.mock("../components/HowTo", async (real) => ({ ...(await real<typeof import("../components/HowTo")>()), ConnectButton: () => <button>Connect your assistant</button> }));

const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe("pages say how they work", () => {
  it("says plainly when only an assistant makes what a page shows, and offers to connect one", () => {
    for (const page of [<ReviewHowTo open />, <ChangesHowTo open />]) {
      const out = html(page);
      expect(out).toContain("Needs your assistant");
      expect(out).toContain("MCP connection");
      expect(out).toContain("Connect your assistant");
      expect(out).toContain("<details class=\"how-to\" open=\"\">");
    }
  });
  it("folds to one line once the page has something to show", () => {
    expect(html(<BuyHowTo open={false} />)).toContain("<details class=\"how-to\"><summary>How the buy list works</summary>");
  });
  it("points at what to do next on the page", () => {
    const trip = html(<TripHowTo open />);
    for (const anchor of ["#trip-list", "#trip-stock", "#trip-prefs"]) expect(trip).toContain(`href="${anchor}"`);
    expect(trip).not.toContain("Needs your assistant");
  });
});
