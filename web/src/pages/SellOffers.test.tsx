import { renderToStaticMarkup } from "react-dom/server";
import { it, expect } from "vitest";
import { SellOffers } from "./SellOffers";
it("offers an explicit local lookup with saved checks and no sale submission", () => {
  const html=renderToStaticMarkup(<SellOffers cards={[]} qty={(c)=>c.qty} onChoose={() => undefined} />);
  expect(html).toContain("Check Mothership (0)");
  expect(html).toContain("Checks are saved to your account");
  expect(html).toContain("No sale is submitted here");
  expect(html).not.toContain("$0.00");
});
