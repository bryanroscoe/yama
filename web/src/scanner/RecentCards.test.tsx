// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecentCards } from "./RecentCards";

const prices = (usd: number | null, foil: number | null = null) => ({ usd, usd_foil: foil, usd_etched: null, date: "2026-11-14" });

describe("Recent, in the scanner's sheet", () => {
  it("shows the last card in full, the ones before it smaller, and the total of known prices", () => {
    const html = renderToStaticMarkup(
      <RecentCards
        cards={[
          { key: "a", name: "Westvale Abbey", set: "soi", number: "281", finish: "foil", copies: 1, prices: prices(1.1, 3.2) },
          { key: "b", name: "Sol Ring", set: "ecc", number: "57", finish: "nonfoil", copies: 2, prices: prices(1.5) },
          { key: "c", name: "Arcane Signet", set: "woc", number: "145", finish: "nonfoil", copies: 1, prices: prices(null) },
        ]}
      />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector(".scan-recent-last")?.textContent).toBe("Last added: Westvale Abbey, SOI 281, Foil, $3.20, market price, Nov 14");
    expect([...doc.querySelectorAll(".scan-recent-older li")].map((li) => li.textContent)).toEqual(["Sol Ring, ECC 57, Regular, $1.50 each, 2 copies, market price, Nov 14", "Arcane Signet, WOC 145, Regular, price unknown"]);
    expect(doc.querySelector(".scan-recent .scan-note")?.textContent).toBe("Total $6.20 for 3 cards, 1 without a price left out.");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("·");
  });

  it("shows nothing before a card is added", () => {
    expect(renderToStaticMarkup(<RecentCards cards={[]} />)).toBe("");
  });
});
