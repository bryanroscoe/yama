// The buy list (docs/planner-design.md section 7, `buyList`): every real card the plan or its
// proposals would buy, grouped by the store whose cart it can go in, with a cart link per store.
// It is a list of proposals and plan rows, not orders: a card is bought only when the plan records
// an order for it. A missing price is counted as missing, never summed as $0: a listing goes in a
// cart only with a price (design section 7: it "has `variant` and `price`"), so a store's checkout
// never costs more than its heading says, and a total with nothing priced is null, not 0.

import { cheapestMarket, priceFlag, recordedMarket, type MarketBasis, type PriceCheck, type PriceData, type RuleSet } from "./rules";
import { boughtInfo, type BoughtInfo, type MarkPair } from "./marks";
import { newestChecks } from "./quotes";
import type { Decision, Mark, PlanBundle, PlanDeck, Quote, Review, Store, Swap } from "./types";

export interface BuyRow {
  swap: Swap;
  deck: PlanDeck | undefined;
  answer: Review | undefined;
  decision: Decision | null;
  /** Your chosen cut, else the suggested one. Null: no slot. */
  replaces: string | null;
  /** The cut is the one you picked, not the suggested one. */
  yourCut: boolean;
  /**
   * The cheapest listing that can go in a store cart (variant and price), from each store's newest
   * check. For a row in `noPrice`, the in-stock listing that has no price.
   */
  listing: Quote | null;
  price: number | null;
  store: Store | null;
  /** The listing judged by the rules in force on its check date. */
  check: PriceCheck | null;
  /** Yama's cheapest non-foil market price, or the plan's recorded benchmark when Yama has none. */
  market: MarketBasis | null;
  /** The plan's recorded benchmarks, newest first. */
  recorded: Quote[];
  /** Each store's newest stock checks other than the chosen listing. */
  others: Quote[];
  /** The "bought it" mark, when set. */
  bought: BoughtInfo | null;
  boughtMark: Mark | undefined;
}

export interface StoreGroup {
  store: Store;
  /** Every row here has a listed price. */
  rows: BuyRow[];
  /** Sum of the rows' listed prices. */
  total: number;
  /** Fills the store's cart with one of each listing; null when the store has no cart link. */
  cartUrl: string | null;
}

export interface BuyList {
  stores: StoreGroup[];
  /** In stock at a store with a cart link, but the check recorded no price: ask the store. Out of carts and totals. */
  noPrice: BuyRow[];
  /** No listing that can go in a cart: ask in store, or print. */
  elsewhere: BuyRow[];
  /** Marked bought here and waiting for the plan to record an order. Out of the totals and carts. */
  marked: BuyRow[];
  /** Proposals you said no to. */
  declined: BuyRow[];
  /** The stock-check dates the list is built from, oldest first. */
  checkedOn: string[];
  /** Sum of every listed price; null when no row has one (never shown as $0). */
  total: number | null;
  /** Rows with a listed price (in the total), rows without one, and all rows. */
  priced: number;
  unpriced: number;
  count: number;
}

export type BuyData = Pick<PlanBundle, "decks" | "swaps" | "quotes" | "stores" | "settings"> & PriceData;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A store cart link with one of each listing: the template's {items} becomes `variant:1,…`. */
export function cartUrl(store: Store, variants: string[]): string | null {
  const t = store.cart_url_template;
  if (!t || !t.startsWith("https://") || !t.includes("{items}") || !variants.length) return null;
  // One line per variant with its quantity (`variant:quantity`), in first-seen order.
  const qty = new Map<string, number>();
  for (const v of variants) qty.set(v, (qty.get(v) ?? 0) + 1);
  return t.replace("{items}", [...qty].map(([v, n]) => `${encodeURIComponent(v)}:${n}`).join(","));
}

export interface BuyListOptions {
  /** Each live swap's answer (aliases followed), as answerIndex returns it. */
  answers: Map<string, Review>;
  /** Each live swap's marks (aliases followed), as markIndex returns it. */
  marks?: Map<string, MarkPair>;
}

/**
 * Proposals to buy that you haven't said no to, plus planned buys with no order yet. Each goes to
 * the store with the cheapest listing that can go in a cart (a variant and a price), taken from each
 * store's newest check: a newer "sold out" replaces an older "in stock". A card whose only in-stock
 * listings have no price goes to `noPrice`, with the listing shown, not into a cart.
 */
export function buyList(b: BuyData, opts: BuyListOptions): BuyList {
  const stores = new Map(b.stores.filter((s) => !s.retired).map((s) => [s.key, s]));
  const decks = new Map(b.decks.map((d) => [d.key, d]));
  const settings = b.settings as unknown as RuleSet[];
  const quotesOf = new Map<string, Quote[]>();
  for (const q of b.quotes) if (q.swap) quotesOf.set(q.swap, [...(quotesOf.get(q.swap) ?? []), q]);

  const groups = new Map<string, BuyRow[]>();
  const noPrice: BuyRow[] = [];
  const elsewhere: BuyRow[] = [];
  const marked: BuyRow[] = [];
  const declined: BuyRow[] = [];
  const checked = new Set<string>();

  for (const s of b.swaps) {
    if (s.retired || s.src !== "buy") continue;
    const deck = decks.get(s.deck);
    if (!deck || deck.status === "archived") continue;
    if (s.stage === "planned" && s.order_item) continue; // bought: the plan has its order
    const answer = opts.answers.get(s.key);
    const decision = answer?.decision ?? null;
    const quotes = quotesOf.get(s.key) ?? [];
    for (const q of quotes) if (q.kind === "stock_check") checked.add(q.checked);
    const latest = newestChecks(quotes);
    const listed = latest.filter((q) => {
      const st = q.store ? stores.get(q.store) : undefined;
      return !!q.variant && !!st?.cart_url_template && q.in_stock !== false;
    });
    const storeSort = (q: Quote) => stores.get(q.store!)?.sort ?? 0;
    const cartable = listed.filter((q) => q.price != null).sort((x, y) => x.price! - y.price! || storeSort(x) - storeSort(y));
    const unpricedListing = listed.filter((q) => q.price == null).sort((x, y) => storeSort(x) - storeSort(y))[0] ?? null;
    const listing = cartable[0] ?? unpricedListing;
    const store = listing?.store ? stores.get(listing.store) ?? null : null;
    const recorded = quotes.filter((q) => q.kind === "market_benchmark").sort((x, y) => cmp(y.checked, x.checked));
    const check = listing
      ? priceFlag(
          { card: s.in, price: listing.price, date: listing.checked, store, text: listing.result, printing: listing, recorded },
          b,
          settings,
        )
      : null;
    const boughtMark = opts.marks?.get(s.key)?.bought;
    const row: BuyRow = {
      swap: s,
      deck,
      answer,
      decision,
      replaces: answer?.cut || s.out || null,
      yourCut: !!answer?.cut && answer.cut !== s.out,
      listing,
      price: listing?.price ?? null,
      store,
      check,
      market: cheapestMarket(s.in, b) ?? recordedMarket(recorded, b.prices_as_of),
      recorded,
      others: latest.filter((q) => q !== listing),
      bought: boughtInfo(boughtMark),
      boughtMark,
    };
    if (s.stage === "proposed" && decision === "no") declined.push(row);
    else if (row.bought) marked.push(row);
    else if (listing && store && listing.price != null) groups.set(store.key, [...(groups.get(store.key) ?? []), row]);
    else if (listing && store) noPrice.push(row);
    else elsewhere.push(row);
  }

  const byDeckCard = (x: BuyRow, y: BuyRow) => cmp(x.deck?.name ?? x.swap.deck, y.deck?.name ?? y.swap.deck) || cmp(x.swap.in, y.swap.in);
  const storeGroups: StoreGroup[] = [...groups]
    .map(([key, rows]) => {
      const store = stores.get(key)!;
      rows.sort(byDeckCard);
      return {
        store,
        rows,
        total: Math.round(rows.reduce((n, r) => n + r.price!, 0) * 100) / 100,
        cartUrl: cartUrl(store, rows.map((r) => r.listing!.variant!)),
      };
    })
    .sort((x, y) => x.store.sort - y.store.sort || cmp(x.store.key, y.store.key));
  for (const list of [noPrice, elsewhere, marked, declined]) list.sort(byDeckCard);
  const priced = storeGroups.reduce((n, g) => n + g.rows.length, 0);
  return {
    stores: storeGroups,
    noPrice,
    elsewhere,
    marked,
    declined,
    checkedOn: [...checked].sort(),
    total: priced ? Math.round(storeGroups.reduce((n, g) => n + g.total, 0) * 100) / 100 : null,
    priced,
    unpriced: noPrice.length + elsewhere.length,
    count: priced + noPrice.length + elsewhere.length,
  };
}

/** Stores that can take a cart, by short name, for "Not stocked at Pat's or Mothership". */
export function cartStoreNames(stores: Store[]): string[] {
  return stores.filter((s) => !s.retired && s.cart_url_template).sort((a, b) => a.sort - b.sort).map((s) => s.short ?? s.name);
}
