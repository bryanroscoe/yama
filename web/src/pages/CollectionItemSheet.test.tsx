import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CollectionItem } from "../api";
import { CollectionItemSheet } from "./CollectionItemSheet";

const row: CollectionItem = {
  id: "row", scryfall_id: "ltr-258", qty: 3, condition: "LP", finish: "foil", lang: "ja", proxy: false, signed: true, altered: false, container_id: null, container_name: null,
  container_kind: null, purchase_price: null, oracle_id: "doom", name: "Mount Doom", set_code: "ltr", set_name: "Tales of Middle-earth", collector_number: "258", rarity: "mythic",
  image_small: null, image_normal: null, type_line: "Legendary Land", color_identity: "BR", unit_price_usd: 5.94, price_date: "2026-10-31",
};

function sheet(item: CollectionItem): string {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter><CollectionItemSheet item={item} containers={[]} onClose={() => undefined} /></MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("a collection row's sheet", () => {
  it("shows and edits the copy's language and whether it's signed or altered", () => {
    const html = sheet(row);
    // The line about the copy says the language by name and the marks it has.
    expect(html).toContain("Tales of Middle-earth #258, foil, lightly played, Japanese, signed");
    expect(html).toMatch(/<section[^>]*aria-labelledby="marks-row"[^>]*><h3 id="marks-row">About this copy<\/h3>/);
    expect(html).toMatch(/<option value="ja" selected="">Japanese<\/option>/);
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>Signed/);
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*\/>Altered art/);
    // Several copies: which of them the mark is for, starting at just one (a tick mustn't mark the row).
    expect(html).toContain('aria-label="Which copies to mark"');
    expect(html).toMatch(/aria-label="Which copies to mark".*?<button[^>]*aria-pressed="true"[^>]*>Just one<\/button>/s);
  });

  it("asks which copies only when the row has more than one", () => {
    const html = sheet({ ...row, qty: 1, lang: "en", signed: false });
    expect(html).not.toContain("Just one");
    expect(html).toContain("Tales of Middle-earth #258, foil, lightly played");
    expect(html).not.toContain("lightly played, English");
  });
});

describe("what the sheet says about the row, and what one choice of copies covers", () => {
  it("says how many copies and what one is worth, with the price's source and date", () => {
    expect(sheet(row)).toContain("3 copies, $5.94 each (TCGplayer market via Scryfall, Oct 31)");
    expect(sheet({ ...row, qty: 1 })).toContain("1 copy, $5.94 (TCGplayer market via Scryfall, Oct 31)");
    // A missing price stays missing; a proxy's price is said to be the real card's.
    expect(sheet({ ...row, unit_price_usd: null })).toContain("3 copies, no market price");
    expect(sheet({ ...row, proxy: true })).toContain("3 proxies. A real copy is $5.94 (TCGplayer market via Scryfall, Oct 31)");
  });

  it("writes conditions out, with the code a store uses", () => {
    const html = sheet(row);
    expect(html).toContain('<option value="LP" selected="">Lightly played (LP)</option>');
    expect(html).toContain('<option value="NM">Near mint (NM)</option>');
  });

  it("asks once which copies a change is for, above where they're kept, and drops the old workaround", () => {
    const html = sheet(row);
    expect(html).toContain('aria-label="Which copies to change"');
    expect(html).toMatch(/aria-label="Which copies to change".*?<button[^>]*aria-pressed="true"[^>]*>All 3 copies<\/button>/s);
    expect(html.indexOf("Which copies to change")).toBeLessThan(html.indexOf("Kept in"));
    expect(html.indexOf("Kept in")).toBeLessThan(html.indexOf("Wrong printing?"));
    expect(html).not.toContain("add it from the Cards tab");
    expect(sheet({ ...row, qty: 1 })).not.toContain("Which copies to change");
  });
});
