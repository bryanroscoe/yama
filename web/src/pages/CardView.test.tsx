import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Card, CardDetail, CollectionItem, Printing } from "../api";
import { addPrinting, CardView, onWishList } from "./CardView";

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

const copy = (over: Partial<CollectionItem>): CollectionItem => ({
  id: "i1", scryfall_id: "p-rvr", qty: 1, condition: "NM", finish: "nonfoil", lang: "en", proxy: false, container_id: null, container_name: null, container_kind: null,
  purchase_price: null, oracle_id: oracleId, name: "Birds of Paradise", set_code: "rvr", set_name: "Ravnica Remastered", collector_number: "133", rarity: "rare",
  image_small: null, image_normal: null, type_line: "Creature — Bird", color_identity: "G", ...over,
} as CollectionItem);

function view(printings: Printing[], readOnly = false, mine: CollectionItem[] = [], wants?: { kind: "card" | "sealed"; name: string }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  if (wants) {
    qc.setQueryData(["me"], { id: "u1", email: "a@example.com", display_name: "A", power: false });
    qc.setQueryData(["plan-cache", "u1"], null);
    qc.setQueryData(["plan", "u1"], { shopping_wants: wants });
  }
  qc.setQueryData<CardDetail>(["card", oracleId], { card, printings, rulings: [] });
  qc.setQueryData(["collection", "card", oracleId], mine);
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
    // The pills say what a tap does: "+ Regular", not a bare finish.
    expect(html).toMatch(/>\+ Regular<\/button>/);
    expect(html).toMatch(/>\+ Surge foil<\/button>/);
    expect(html).toMatch(/>\+ Proxy<\/button>/);
    expect(html).toContain('aria-label="Add an etched Commander Masters #455 copy to your collection"');
    for (const set of ["Ravnica Remastered #133", "Marvel Super Heroes Commander #40", "Commander Masters #455"])
      expect(html).toContain(`aria-label="Add a proxy with the ${set} art to your collection"`);
    // No cryptic +1/+F buttons.
    expect(html).not.toMatch(/>\+[1FE]<\/button>/);
  });

  it("says which printing Add to collection adds, and never one that isn't out yet", () => {
    const out = printing({ scryfall_id: "p-rvr" });
    const coming = printing({ scryfall_id: "p-new", set_name: "Darkhold Destiny", collector_number: "301", released_at: "2027-04-09", usd: null, usd_foil: null, price_date: null });
    const day = "2026-11-21";
    // Scryfall's default when it is out and priced, as before.
    expect(addPrinting([coming, out], "p-rvr", day)?.scryfall_id).toBe("p-rvr");
    // A default from a set that isn't on sale gives way to one that is.
    expect(addPrinting([coming, out], "p-new", day)?.scryfall_id).toBe("p-rvr");
    // Out, but with no price: a priced printing first; with none priced, the default.
    const unpriced = printing({ scryfall_id: "p-old", usd: null, usd_foil: null });
    expect(addPrinting([unpriced, out], "p-old", day)?.scryfall_id).toBe("p-rvr");
    expect(addPrinting([unpriced, printing({ scryfall_id: "p-x", usd: null })], "p-x", day)?.scryfall_id).toBe("p-x");
    // Nothing out yet (a previewed card): what there is.
    expect(addPrinting([coming], "p-new", day)?.scryfall_id).toBe("p-new");
    expect(addPrinting([], "p-new", day)).toBeUndefined();
    const html = view([out, printing({ scryfall_id: "p-cmm", set_name: "Commander Masters", collector_number: "455" })]);
    expect(html).toContain("Add to collection adds Ravnica Remastered #133, not filed. Pick another printing below.");
    expect(html).toContain(">Add to wish list</button>");
  });

  it("says a card is on the wish list already instead of offering to add it again", () => {
    const html = view([printing({ scryfall_id: "p-rvr" })], false, [], [{ kind: "card", name: "birds of paradise" }]);
    expect(html).toMatch(/<a [^>]*href="\/collection\/wishlist"[^>]*>On your wish list<\/a>/);
    expect(html).not.toContain("Add to wish list");
    // Not on it: the button, once the list has been read.
    const off = view([printing({ scryfall_id: "p-rvr" })], false, [], [{ kind: "card", name: "Sol Ring" }]);
    expect(off).toMatch(/<button[^>]*>Add to wish list<\/button>/);
    expect(off).not.toMatch(/<button[^>]*disabled[^>]*>Add to wish list/);
    expect(off).not.toContain("On your wish list");
    // Whichever deck the row is for; a sealed product of the same name isn't the card; a
    // two-faced card listed by its front face is.
    const wants = [{ kind: "card" as const, name: " Sol Ring ", deck_id: "d1" }, { kind: "sealed" as const, name: "Birds of Paradise" }, { kind: "card" as const, name: "Fire" }];
    expect(onWishList(wants, "sol ring")?.deck_id).toBe("d1");
    expect(onWishList(wants, "Birds of Paradise")).toBeUndefined();
    expect(onWishList(wants, "Fire // Ice")?.name).toBe("Fire");
    expect(onWishList([], "Sol Ring")).toBeUndefined();
  });

  it("counts proxies apart from the cards you own", () => {
    const html = view([printing({ scryfall_id: "p-rvr" })], false, [copy({ qty: 4 }), copy({ id: "i2", qty: 1, proxy: true })]);
    expect(html).toContain('<span class="cp-narrow">4</span><span class="cp-fact-also">, and 1 proxy</span>');
    expect(html).toContain('<span class="cp-wide">4 copies</span>');
    const only = view([printing({ scryfall_id: "p-rvr" })], false, [copy({ id: "i2", qty: 2, proxy: true })]);
    expect(only).toContain('<b class="cp-fact-big">2 proxies</b>');
    expect(only).toContain("No real copy. ");
    expect(view([printing({ scryfall_id: "p-rvr" })], false, [copy({ qty: 1 })])).toContain('<span class="cp-wide">1 copy</span><span class="cp-narrow">1</span></b>');
  });

  it("says a printing has no foil price in words", () => {
    const html = view([printing({ scryfall_id: "p-rvr", usd_foil: null })]);
    expect(html).toContain("#133. No foil price</span>");
    expect(html).not.toContain("Foil market No price");
  });

  it("has no add buttons on a read-only card, but still the pictures", () => {
    const html = view([printing({ scryfall_id: "p-rvr" })], true);
    expect(html).not.toContain("Add a proxy with");
    expect(html).not.toContain("Add to wish list");
    expect(html).toContain('src="https://img/small/rvr.jpg"');
  });
});
