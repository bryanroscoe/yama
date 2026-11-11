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
    expect(html).toContain("Tales of Middle-earth #258, foil, LP, Japanese, signed");
    expect(html).toContain('aria-label="Language, signed and altered"');
    expect(html).toMatch(/<option value="ja" selected="">Japanese<\/option>/);
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>Signed/);
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*\/>Altered/);
    // Several copies: which of them the mark is for.
    expect(html).toContain("All 3 copies");
    expect(html).toContain("Just one");
  });

  it("asks which copies only when the row has more than one", () => {
    const html = sheet({ ...row, qty: 1, lang: "en", signed: false });
    expect(html).not.toContain("Just one");
    expect(html).toContain("Tales of Middle-earth #258, foil, LP");
    expect(html).not.toContain("LP, English");
  });
});
