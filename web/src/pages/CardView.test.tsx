import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Card, CardDetail, Printing } from "../api";
import { CardView } from "./CardView";

const oracleId = "o-birds";
const card: Card = {
  oracle_id: oracleId, name: "Birds of Paradise", mana_cost: "{G}", cmc: 1, type_line: "Creature — Bird", oracle_text: "Flying", colors: "G", color_identity: "G",
  power: "0", toughness: "1", loyalty: null, rarity: "rare", layout: "normal", legalities: { commander: "legal" }, image_small: null, image_normal: "https://img/normal/birds.jpg",
  image_art_crop: null, back_image_normal: null, artist: "Marcelo Vignali", default_printing: "p-rvr", edhrec_rank: 1, game_changer: false,
};
const printing = (over: Partial<Printing>): Printing => ({
  scryfall_id: "p", oracle_id: oracleId, name: "Birds of Paradise", set_code: "rvr", set_name: "Ravnica Remastered", collector_number: "133", lang: "en", rarity: "rare",
  finishes: ["nonfoil", "foil"], released_at: "2024-01-12", image_normal: "https://img/normal/rvr.jpg", image_small: "https://img/small/rvr.jpg", back_image_normal: null, artist: null,
  price_date: "2026-11-15", usd: 14.53, usd_foil: 13.59, usd_etched: null, eur: null, eur_foil: null, ...over,
});

function view(printings: Printing[], readOnly = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData<CardDetail>(["card", oracleId], { card, printings, rulings: [] });
  qc.setQueryData(["collection", "card", oracleId], []);
  qc.setQueryData(["card-in-decks", oracleId], { decks: [], combos: [], more_combos: 0 });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardView oracleId={oracleId} onBack={() => {}} backLabel="Back" readOnly={readOnly} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("a card's printings", () => {
  it("shows each printing's picture, which opens full size", () => {
    const html = view([printing({ scryfall_id: "p-rvr" })]);
    expect(html).toContain('src="https://img/small/rvr.jpg"');
    expect(html).toContain('aria-label="Show Birds of Paradise, Ravnica Remastered #133 larger"');
    // A printing without any picture says so rather than drawing nothing.
    expect(view([printing({ scryfall_id: "p-none", image_small: null, image_normal: null })])).toContain("No picture");
  });

  it("adds a regular, foil or proxy copy of that printing, naming a special foil", () => {
    const html = view([
      printing({ scryfall_id: "p-rvr" }),
      printing({ scryfall_id: "p-msc", set_name: "Marvel Super Heroes Commander", collector_number: "40", promo_types: ["surgefoil"] }),
      printing({ scryfall_id: "p-cmm", set_name: "Commander Masters", collector_number: "455", finishes: ["etched"] }),
    ]);
    expect(html).toContain('aria-label="Add a regular Ravnica Remastered #133 copy to your collection"');
    expect(html).toContain('aria-label="Add a foil Ravnica Remastered #133 copy to your collection"');
    expect(html).toContain('aria-label="Add a surge foil Marvel Super Heroes Commander #40 copy to your collection"');
    expect(html).toMatch(/>Surge foil<\/button>/);
    expect(html).toContain('aria-label="Add an etched Commander Masters #455 copy to your collection"');
    for (const set of ["Ravnica Remastered #133", "Marvel Super Heroes Commander #40", "Commander Masters #455"])
      expect(html).toContain(`aria-label="Add a proxy with the ${set} art to your collection"`);
    // No cryptic +1/+F buttons.
    expect(html).not.toMatch(/>\+[1FE]<\/button>/);
  });

  it("has no add buttons on a read-only card, but still the pictures", () => {
    const html = view([printing({ scryfall_id: "p-rvr" })], true);
    expect(html).not.toContain("Add a proxy with");
    expect(html).toContain('src="https://img/small/rvr.jpg"');
  });
});
