import { describe, expect, it } from "vitest";
import { cartCheck, emptyLive, liveRows, mergeLive, migrateChoices, soldOut, storeProgress, type LiveListing, type LiveStock, type LiveStore } from "./live-stock";
import { allChoices, offerId, sourceCarts, type SourceCard, type SourceOffer } from "./sourcing-model";
import { pricedRows } from "./source-pricing";

const READ = "2026-11-13T12:00:00.000Z";
const store: LiveStore = { key: "mothership", name: "Mothership", origin: "https://mothershipatx.com", wanted: 2, read: 2, fresh: 2, hurrying: 0, oldest: READ, newest: READ, failed: 0, error: null, failed_cards: [] };
const saved = (over: Partial<SourceOffer> = {}): SourceOffer => ({ store: "Mothership", price: 1.5, qty: null, condition: "Near Mint", url: "https://mothershipatx.com/products/path-ac", variant_id: "111", checked_at: "2026-11-10", qualifies: true, title: "Path to Exile [Assassin's Creed]", finish: "nonfoil", language: "English", market: 2, market_source: "https://scryfall.com/card/acr/1", market_checked_at: "2026-11-10", market_match: "retailer image ID", printing_id: "print-ac", ...over });
const elsewhere = saved({ store: "Multiverse Hobbies", url: "https://mversetcg.tcgplayerpro.com/p/1", variant_id: "", qty: 3, price: 1.25 });
const card = (offers: SourceOffer[] = [saved(), elsewhere]): SourceCard => ({ name: "Path to Exile", status: "qualifying", uses: [{ id: "a", deck: "d", deck_name: "Deck", category: "unresolved" }], offers });
const listing = (over: Partial<LiveListing> = {}): LiveListing => ({ title: "Path to Exile [Assassin's Creed] - Near Mint", set: "Assassin's Creed", finish: "nonfoil", condition: "Near Mint", language: null, price: 1.75, variant: "111", url: "https://mothershipatx.com/products/path-ac?variant=111", ...over });
const answered = (listings: LiveListing[], checked_at = READ): LiveStock => ({ at: "2026-11-13T12:00:01.000Z", reread_hours: 8, offline: false, stores: [store], answers: [{ origin: store.origin, card: "Path to Exile", checked_at, listings }], markets: { "Path to Exile": { usd: 1.4, date: "2026-11-12", printing: "Test Set (TST) #7", source: "TCGplayer market via Scryfall, cheapest non-foil" } }, unknown: [], hurried: 0 });
const held = (listings: LiveListing[], checked_at = READ) => mergeLive(emptyLive, answered(listings, checked_at));
const rule = { max_usd: 5, always_ok_usd: null, tiers: [{ market_under: null, max_multiple: 1 }] };

describe("live store stock on the sourcing page", () => {
  it("puts a store's newer answer in place of its saved quotes and leaves other stores alone", () => {
    const rows = liveRows([card()], held([
      listing(),
      listing({ title: "Path to Exile [Assassin's Creed] - Lightly Played", condition: "Lightly Played", price: 1, variant: "222", url: "https://mothershipatx.com/products/path-ac?variant=222" }),
      listing({ title: "Path to Exile [MagicFest Cards] - Near Mint", price: 0.9, variant: "333", url: "https://mothershipatx.com/products/path-mf?variant=333" }),
      listing({ title: "Path to Exile [Assassin's Creed] - Near Mint Foil", finish: "foil", price: 1.8, variant: "444", url: "https://mothershipatx.com/products/path-ac?variant=444" }),
    ]));
    const offers = rows[0]!.offers, by = (v: string) => offers.find(o => o.variant_id === v)!;
    expect(offers.filter(o => o.store === "Multiverse Hobbies")).toEqual([elsewhere]);
    expect(offers.filter(o => o.store === "Mothership").map(o => o.variant_id)).toEqual(["111", "222", "333", "444"]);
    // The saved variant: today's price, the saved link (a selection made earlier still finds it) and its printing market.
    expect(by("111")).toMatchObject({ price: 1.75, checked_at: READ, live: true, qty: null, market: 2, printing_id: "print-ac", market_match: "retailer image ID" });
    expect(offerId(by("111"))).toBe(offerId(saved()));
    // Another condition of the same product is the same printing.
    expect(by("222")).toMatchObject({ price: 1, condition: "Lightly Played", market: 2, printing_id: "print-ac" });
    // A printing the report never saw is judged against the card's cheapest non-foil printing.
    expect(by("333")).toMatchObject({ market: 1.4, market_checked_at: "2026-11-12", market_match: "cheapest non-foil printing", printing_id: undefined, non_price_eligible: true });
    // Foil of a card with a plain version shops only when foil is preferred, and takes no nonfoil printing's market from the same page.
    expect(by("444")).toMatchObject({ foil_alternative: true, non_price_eligible: true, finish: "foil", market: 1.4 });
  });

  it("drops a saved listing the store no longer has, and says which selected cards sold out", () => {
    const before = [card()];
    const choices = allChoices(pricedRows(before, rule));
    expect(choices["Path to Exile"]).toEqual([{ offer: offerId(elsewhere), qty: 1 }]);
    const picked = { "Path to Exile": [{ offer: offerId(saved()), qty: 1 }] };
    const after = liveRows(before, held([]));
    expect(after[0]!.offers).toEqual([elsewhere]);
    expect(soldOut(before, picked)).toEqual([]);
    expect(soldOut(after, picked)).toEqual(["Path to Exile"]);
    expect(sourceCarts(pricedRows(after, rule), picked, new Map())).toEqual([]);
  });

  it("moves a pick on a saved listing without a variant id to the one live listing that is it", () => {
    const loose = saved({ variant_id: "" });
    const before = [card([loose, elsewhere])];
    const picked = { "Path to Exile": [{ offer: offerId(loose), qty: 1 }] };
    const lightly = listing({ title: "Path to Exile [Assassin's Creed] - Lightly Played", condition: "Lightly Played", price: 1, variant: "222", url: "https://mothershipatx.com/products/path-ac?variant=222" });
    const after = liveRows(before, held([listing(), lightly]));
    const moved = migrateChoices(picked, after);
    expect(moved["Path to Exile"]).toEqual([{ offer: "https://mothershipatx.com/products/path-ac?variant=111#variant=111", qty: 1 }]);
    expect(soldOut(after, moved)).toEqual([]);
    expect(sourceCarts(pricedRows(after, rule), moved, new Map())[0]!.rows.map(r => [r.offer.variant_id, r.qty])).toEqual([["111", 1]]);
    expect(migrateChoices(moved, after)).toBe(moved);
    // Sold out in that condition: the pick stays where it was and reads as sold out; it never moves to another condition.
    const gone = liveRows(before, held([lightly]));
    expect(migrateChoices(picked, gone)).toBe(picked);
    expect(soldOut(gone, migrateChoices(picked, gone))).toEqual(["Path to Exile"]);
    // Two live listings that could both be it: nothing is guessed.
    const twins = liveRows(before, held([listing(), listing({ variant: "112", url: "https://mothershipatx.com/products/path-ac?variant=112" })]));
    expect(migrateChoices(picked, twins)).toBe(picked);
  });

  it("offers a store's cart as checked only once its listings were reread, and names the ones that could not be", () => {
    const now = Date.parse(READ) + 10 * 60_000;
    const fresh = liveRows([card()], held([listing()]))[0]!.offers.find(o => o.live)!;
    expect(cartCheck([{ card: "Path to Exile", offer: fresh }], store, now)).toEqual({ waiting: 0, failed: [] });
    expect(cartCheck([{ card: "Path to Exile", offer: fresh }], store, now + 2 * 60 * 60_000)).toEqual({ waiting: 1, failed: [] });
    expect(cartCheck([{ card: "Path to Exile", offer: saved() }], store, now)).toEqual({ waiting: 1, failed: [] });
    expect(cartCheck([{ card: "Path to Exile", offer: saved() }], { ...store, failed_cards: ["Path to Exile"] }, now)).toEqual({ waiting: 0, failed: ["Path to Exile"] });
  });

  it("keeps the report where the store has no answer yet or the saved quote is newer", () => {
    const cards = [card()];
    expect(liveRows(cards, emptyLive)).toBe(cards);
    const other = mergeLive(emptyLive, { ...answered([]), answers: [{ origin: store.origin, card: "Another Card", checked_at: READ, listings: [] }] });
    expect(liveRows(cards, other)[0]).toBe(cards[0]);
    const newer = [card([saved({ checked_at: "2026-11-14" }), elsewhere])];
    expect(liveRows(newer, held([]))[0]!.offers).toEqual(newer[0]!.offers);
  });

  it("judges what the store lists by the buying rule and the listing's own words", () => {
    const rows = pricedRows(liveRows([card([elsewhere])], held([
      listing({ price: 1.4, variant: "1" }),
      listing({ price: 3, variant: "2" }),
      listing({ title: "Path to Exile [Set] - Near Mint / Japanese / Normal", language: "Japanese", price: 0.5, variant: "3" }),
      listing({ title: "Path to Exile [Set] - Damaged", condition: "Damaged", price: 0.5, variant: "4" }),
      listing({ price: null, variant: "5" }),
      listing({ url: "javascript:alert(1)", variant: "6" }),
    ])), rule);
    const mine = rows[0]!.offers.filter(o => o.live);
    expect(mine.map(o => [o.variant_id, o.qualifies])).toEqual([["1", true], ["2", false], ["3", false], ["4", false]]);
    expect(mine.every(o => o.store === "Mothership" && o.language !== "")).toBe(true);
  });

  it("holds the newest answer for each store and card across asks", () => {
    const first = held([listing()]);
    const older = mergeLive(first, answered([], "2026-11-13T09:00:00.000Z"));
    expect(older.answers.get("https://mothershipatx.com\nPath to Exile")!.listings).toHaveLength(1);
    const next = mergeLive(first, { ...answered([], "2026-11-13T15:00:00.000Z"), at: "2026-11-13T15:00:01.000Z", markets: {} });
    expect(next.answers.get("https://mothershipatx.com\nPath to Exile")!.listings).toEqual([]);
    expect(next.at).toBe("2026-11-13T15:00:01.000Z");
    expect(next.markets.get("Path to Exile")!.usd).toBe(1.4);
  });

  it("says how far each store's reader has got", () => {
    const when = (at: string) => `at ${at.slice(11, 16)}`;
    expect(storeProgress({ ...store, wanted: 0 }, when)).toBe("Mothership: no cards to read.");
    expect(storeProgress({ ...store, wanted: 862, read: 0, fresh: 0, oldest: null, newest: null }, when)).toBe("Mothership: not read yet. 862 cards are waiting their turn.");
    expect(storeProgress({ ...store, wanted: 862, read: 840, fresh: 840, oldest: "2026-11-13T07:00:00.000Z", hurrying: 12, failed: 2 }, when))
      .toBe("Mothership: 840 of 862 cards read, the oldest at 07:00, the newest at 12:00. 22 still waiting for a first read. Rechecking 12 in your carts first. 2 could not be read on the last try and will be tried again.");
  });
});
