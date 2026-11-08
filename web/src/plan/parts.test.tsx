import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SwapPair } from "./parts";

const view = {
  card: (n: string) => ({ name: n, image_small: `https://cards.scryfall.io/small/${encodeURIComponent(n)}.jpg`, image_normal: null }) as never,
  oracleId: (n: string) => `o-${n}`,
};

describe("a change's two cards", () => {
  it("shows the card going in, an arrow, then the card it replaces", () => {
    const html = renderToStaticMarkup(<SwapPair cardIn="Brazen Borrower" cardOut="Wayfarer's Bauble" view={view} />);
    expect(html.indexOf("Show Brazen Borrower")).toBeLessThan(html.indexOf("plan-pair-arrow"));
    expect(html.indexOf("plan-pair-arrow")).toBeLessThan(html.indexOf("Show Wayfarer&#x27;s Bauble"));
    expect(html).not.toContain("plan-pair-empty");
  });

  it("leaves a dashed empty slot when no cut is named", () => {
    const html = renderToStaticMarkup(<SwapPair cardIn="Aetherize" cardOut={null} view={view} />);
    expect(html).toContain("Show Aetherize");
    expect(html).toContain('class="plan-pair-empty" aria-hidden="true"');
  });
});
