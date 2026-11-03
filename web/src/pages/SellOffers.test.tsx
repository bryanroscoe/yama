import { renderToStaticMarkup } from "react-dom/server";
import { it, expect } from "vitest";
import { OfferSummary, SellOffers } from "./SellOffers";
it("offers an explicit local lookup with saved checks and no sale submission", () => {
  const html=renderToStaticMarkup(<SellOffers cards={[]} qty={(c)=>c.qty} onChoose={() => undefined} />);
  expect(html).toContain("Check Mothership (0)");
  expect(html).toContain("Checks are saved to your account");
  expect(html).toContain("No sale is submitted here");
  expect(html).not.toContain("$0.00");
});

it("labels partial credit separately from the complete cash total", () => {
  const total = { copies: 2, cash: 2, credit: 1.15, creditUnknown: 1, unchecked: 0, quantities: new Map<string, number>() };
  const html = renderToStaticMarkup(<OfferSummary total={total} />);
  expect(html).toContain("2 copies: $2.00 cash");
  expect(html).toContain("known store credit subtotal: $1.15");
  expect(html).toContain("credit unknown for 1 copy");
  expect(html).not.toContain("or $1.15 store credit");
  const known = renderToStaticMarkup(<OfferSummary total={{ ...total, creditUnknown: 0 }} />);
  expect(known).toContain("or $1.15 store credit");
  expect(known).not.toContain("subtotal");
  const unknown = renderToStaticMarkup(<OfferSummary total={{ ...total, creditUnknown: 2, credit: 0 }} />);
  expect(unknown).toContain("credit unknown for 2 copies");
  expect(unknown).not.toContain("$0.00");
});
