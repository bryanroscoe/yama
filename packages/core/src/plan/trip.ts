// The store trip (docs/shopping-design.md): which of your stores to visit for the cards you want,
// using as few stores as possible, judged by your local buy rule. A store listing is a dated quote,
// not a purchase or a promise that the card is still there; a missing price is unknown, never $0.
//
// What drives the choice of stores ("needed"): planned buys with no order yet and proposals you
// said you want. What comes along if a chosen store has it ("along the way"): proposals you haven't
// decided on and your real-card wishlist. Neither ever makes you visit one more store.
//
// server/src/plan/trip.rs is a port of this for Claude's `shopping_trip` tool. Keep them in step:
// both are checked against fixtures/trip.json.

import { boughtInfo, markIndex } from "./marks";
import { newestChecks } from "./quotes";
import { cheapestMarket, printingMarket, recordedMarket, rulesAt, type MarketBasis, type PriceData, type RuleSet, type Rules } from "./rules";
import { usd } from "./source";
import { answerIndex } from "./text";
import { cartUrl } from "./buy";
import { massEntryUrl, pasteText, proSearchUrl } from "./carts";
import type { Decision, PlanBundle, Quote, Review, Store, StorePreference } from "./types";

// ── the buy rule ───────────────────────────────────────────────────────────

/**
 * The local buy rule (Bryan, 2026-10-28): at most `max_usd`; at or under `always_ok_usd` whatever
 * the market (and the only way an unknown market qualifies); otherwise at most `max_multiple` times
 * the market of the first tier whose `market_under` is above the market (null: any market).
 */
export interface LocalBuyRule {
  max_usd: number | null;
  always_ok_usd: number | null;
  tiers: { market_under: number | null; max_multiple: number }[];
}

export interface TripRule {
  rule: LocalBuyRule | null;
  /** The rule set it comes from, by its start date; null when no set is in force. */
  from: string | null;
  /** Built from the set's older fields (ceiling and percent over market), not a `local_buy` rule. */
  derived: boolean;
  text: string;
}

const EPS = 1e-9;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The rule set's `local_buy` rule, else one built from its ceiling and percent over market. */
export function localBuyRule(set: RuleSet | null): TripRule {
  if (!set) return { rule: null, from: null, derived: false, text: "No shopping rules are in force, so every listed price counts." };
  const r: Rules = set.rules;
  const lb = r.local_buy;
  if (lb && typeof lb === "object") {
    const tiers = (Array.isArray(lb.tiers) ? lb.tiers : [])
      .map((t) => ({ market_under: num(t?.market_under), max_multiple: num(t?.max_multiple) }))
      .filter((t): t is { market_under: number | null; max_multiple: number } => t.max_multiple != null && t.max_multiple > 0);
    const rule = { max_usd: num(lb.max_usd), always_ok_usd: num(lb.always_ok_usd), tiers };
    return { rule, from: set.effective_from, derived: false, text: ruleText(rule) };
  }
  const max = num(r.ceiling_other_usd) ?? num(r.ceiling_key_usd) ?? num(r.always_print_over_usd);
  const pct = num(r.max_over_market_pct);
  const rule: LocalBuyRule = { max_usd: max, always_ok_usd: null, tiers: pct != null ? [{ market_under: null, max_multiple: 1 + pct / 100 }] : [] };
  return { rule, from: set.effective_from, derived: true, text: `${ruleText(rule)} (from your ceiling and limit over market; this rule set has no local buy rule)` };
}

const times = (x: number) => `${Number(x.toFixed(2))}×`;

export function ruleText(rule: LocalBuyRule): string {
  const parts: string[] = [];
  if (rule.max_usd != null) parts.push(`at most ${usd(rule.max_usd)}`);
  if (rule.always_ok_usd != null) parts.push(`${usd(rule.always_ok_usd)} or less whatever the market`);
  let low = 0;
  for (const t of rule.tiers) {
    const range = t.market_under == null ? (low ? `when market is ${usd(low)} or more` : "") : low ? `when market is ${usd(low)} to ${usd(t.market_under)}` : `when market is under ${usd(t.market_under)}`;
    parts.push(`at most ${times(t.max_multiple)} market${range ? ` ${range}` : ""}`);
    if (t.market_under != null) low = t.market_under;
  }
  const top = rule.tiers[rule.tiers.length - 1]?.market_under;
  if (top != null) parts.push(`nothing qualifies when market is ${usd(top)} or more`);
  if (rule.tiers.length) parts.push(rule.always_ok_usd != null ? `an unknown market qualifies only at ${usd(rule.always_ok_usd)} or less` : "an unknown market doesn't qualify");
  return parts.length ? `Buy locally: ${parts.join("; ")}.` : "Every listed price counts.";
}

export type Verdict = "ok" | "over-max" | "over-market" | "no-market";

/** Whether a price qualifies under the rule, given the market (null: unknown). No rule: it does. */
export function judge(rule: LocalBuyRule | null, price: number, market: number | null): Verdict {
  if (!rule) return "ok";
  if (rule.max_usd != null && price > rule.max_usd + EPS) return "over-max";
  if (rule.always_ok_usd != null && price <= rule.always_ok_usd + EPS) return "ok";
  if (!rule.tiers.length) return "ok";
  if (market == null) return "no-market";
  const tier = rule.tiers.find((t) => t.market_under == null || market < t.market_under);
  if (!tier) return "over-market"; // above every range the rule names
  return price <= tier.max_multiple * market + EPS ? "ok" : "over-market";
}

// ── preferences ────────────────────────────────────────────────────────────

/** Lower is preferred. A store with no preference is "ok". */
const RANK: Record<StorePreference, number> = { favorite: 0, ok: 1, maybe: 2, never: 3 };

export function storePreference(b: Pick<PlanBundle, "store_prefs">, key: string): StorePreference {
  const p = b.store_prefs?.[key]?.preference;
  if (p === "default") return "favorite"; // bundles from before migration 0050
  return p && p in RANK ? p : "ok";
}

export const PREFERENCE_TEXT: Record<StorePreference, string> = {
  favorite: "Favourite, support them",
  ok: "Fine to go",
  maybe: "Maybe, one trip",
  never: "Won't go",
};

/** How much more a card may cost at this store and still come from it (USD, 0 when unset). */
export function storePremium(b: Pick<PlanBundle, "store_prefs">, key: string): number {
  if (storePreference(b, key) !== "favorite") return 0; // a premium kept from when it was a favourite
  const v = num(b.store_prefs?.[key]?.premium_usd);
  return v != null && v > 0 ? v : 0;
}

/**
 * Every store's place in your order of how easy it is to get to, from 1: the stores you numbered
 * first (by their number), then the rest in the plan's store order. Retired stores and printers
 * have no place.
 */
export function hassleOrder(b: Pick<PlanBundle, "store_prefs" | "stores">): Map<string, number> {
  const h = (k: string) => num(b.store_prefs?.[k]?.hassle) ?? Number.MAX_SAFE_INTEGER;
  const order = b.stores.filter((s) => !s.retired && s.kind !== "printer").sort((x, y) => h(x.key) - h(y.key) || x.sort - y.sort || cmp(x.key, y.key));
  return new Map(order.map((s, i) => [s.key, i + 1]));
}

// ── the plan ───────────────────────────────────────────────────────────────

export type WantSource = "plan" | "proposal" | "wishlist";

export interface Want {
  /** The swap key, or `wish:` and the card for a wishlist entry. */
  id: string;
  card: string;
  source: WantSource;
  /** Needed ones decide the stores; the rest come along when a chosen store has them. */
  needed: boolean;
  deck: string | null;
  deckName: string | null;
  replaces: string | null;
  decision: Decision | null;
  reason: string | null;
}

export interface TripOffer {
  quote: Quote;
  store: Store;
  preference: StorePreference;
  price: number;
  market: MarketBasis | null;
  verdict: Verdict;
}

export interface TripRow {
  want: Want;
  offer: TripOffer;
}

export interface TripStop {
  store: Store;
  preference: StorePreference;
  /** Needed cards from this store, cheapest qualifying copy among the chosen stores. */
  rows: TripRow[];
  /** Undecided proposals and wishlist cards this store also has under your rule. */
  along: TripRow[];
  /** Listed prices of `rows`, before tax. */
  total: number;
  alongTotal: number;
  /** A cart with the needed rows that have a cart line; null when the store has no cart link. */
  cartUrl: string | null;
  /** Needed rows with no cart line: ask at the counter. */
  noCartLine: number;
  /** The needed cards as a list to paste, "1 Card" a line. */
  paste: string;
  /** On a TCGplayer Pro storefront, which has no cart link: a search for each needed card. */
  search: { card: string; url: string }[];
}

export type PrintReason = "never-store" | "not-local" | "left-out" | "over-max" | "over-market" | "no-market" | "no-price" | "unknown-stock" | "not-stocked" | "no-check";

export interface PrintRow {
  want: Want;
  reason: PrintReason;
  /** The cheapest listing that explains the reason, when there is one. */
  offer: TripOffer | null;
  /** For "never-store", "not-local" and "left-out": the stores off this trip that have it under your rule. */
  stores: string[];
}

export interface TripAlternative {
  stores: string[];
  covered: number;
  total: number;
}

export interface WishTier {
  label: string;
  items: { want: Want; market: MarketBasis | null }[];
  /** Sum of the known market prices; null when none is known. */
  market: number | null;
}

export type SkipReason = "never" | "not-local" | "left-out";

export interface TripPlan {
  today: string;
  rule: TripRule;
  stops: TripStop[];
  /** Needed cards, and how many the stops cover. */
  needed: number;
  covered: number;
  /** Listed total of the stops' needed rows, before tax; null when nothing is covered. */
  total: number | null;
  /** The best choice with one store, two stores, and so on, up to the most cards coverable. */
  alternatives: TripAlternative[];
  /** Needed cards no chosen store has under your rule: print them, or check by hand. */
  print: PrintRow[];
  /** Those cards as a list to paste, and as a TCGplayer Mass Entry link (null: none, or too long). */
  printPaste: string;
  printMassEntry: string | null;
  /** Cards along the way that only stores you aren't visiting have, by store. */
  elsewhere: { store: Store; preference: StorePreference; rows: TripRow[] }[];
  /**
   * Stores off this trip that have needed cards under your rule, with how many: ones you won't go
   * to, ones that aren't local when your rule says buy local, and ones you left off this time.
   */
  skipped: { store: Store; preference: StorePreference; cards: number; why: SkipReason }[];
  /** The stores you said you're going to this time; null: every store you'll go to. */
  going: string[] | null;
  /** Check dates of the listings considered, oldest first. */
  checkedOn: string[];
  wishlist: WishTier[];
}

export interface TripOptions {
  /** YYYY-MM-DD: picks the rule set in force. */
  today: string;
  /** Answers as `answerIndex` gives them (the page passes its overlay). Default: from the bundle. */
  answers?: Map<string, Review>;
  /** Bought marks per live swap. Default: from the bundle. */
  bought?: (key: string) => boolean;
  /** The store keys you're going to this time; null or missing: every store you'll go to. */
  stores?: string[] | null;
}

export type TripData = Pick<PlanBundle, "decks" | "swaps" | "quotes" | "stores" | "settings" | "aliases" | "reviews" | "marks" | "store_prefs" | "wishlist"> & PriceData;

/** At most this many stores are searched exhaustively; more are cut to those covering the most. */
const MAX_SEARCH = 12;

const norm = (s: string) => s.trim().toLowerCase();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cents = (x: number) => Math.round(x * 100) / 100;

/** The wants: planned buys with no order, proposals to buy not answered no, and the wishlist. */
export function tripWants(b: TripData, answers: Map<string, Review>, bought: (key: string) => boolean): Want[] {
  const decks = new Map(b.decks.map((d) => [d.key, d]));
  const out: Want[] = [];
  const seen = new Set<string>();
  for (const s of b.swaps) {
    if (s.retired || s.src !== "buy") continue;
    const deck = decks.get(s.deck);
    if (!deck || deck.status === "archived") continue;
    if (s.stage === "planned" && s.order_item) continue;
    if (bought(s.key)) continue;
    const answer = answers.get(s.key);
    const decision = answer?.decision ?? null;
    if (s.stage === "proposed" && decision === "no") continue;
    const needed = s.stage === "planned" || decision === "want";
    out.push({
      id: s.key,
      card: s.in,
      source: s.stage === "planned" ? "plan" : "proposal",
      needed,
      deck: s.deck,
      deckName: deck.name,
      replaces: answer?.cut || s.out || null,
      decision,
      reason: s.why,
    });
    seen.add(norm(s.in));
  }
  for (const w of b.wishlist ?? []) {
    if (seen.has(norm(w.card))) continue;
    seen.add(norm(w.card));
    out.push({ id: `wish:${w.card}`, card: w.card, source: "wishlist", needed: false, deck: null, deckName: null, replaces: null, decision: null, reason: w.reason });
  }
  return out;
}

/** A foil or etched listing ("non-foil" doesn't count), whatever else it says ("Borderless Foil"). */
export function foilListing(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase().replaceAll("non-foil", " ").replaceAll("nonfoil", " ");
  return t.split(/[^a-z0-9]+/).some((w) => w === "foil" || w === "etched");
}

/** A listing's market for the rule: its own printing, else the cheapest non-foil copy, else the plan's benchmark. */
function offerMarket(q: Quote, card: string, recorded: Quote[], p: PriceData): MarketBasis | null {
  const ref = q.scryfall_id || (q.set && q.num) ? { scryfall_id: q.scryfall_id, set: q.set, num: q.num } : null;
  return printingMarket(ref, p) ?? cheapestMarket(card, p) ?? recordedMarket(recorded, p.prices_as_of);
}

/** Plan the trip from the bundle. */
export function planTrip(b: TripData, opts: TripOptions): TripPlan {
  const live = b.swaps.filter((s) => !s.retired).map((s) => s.key);
  const answers = opts.answers ?? answerIndex(b.reviews ?? {}, b.aliases ?? {}, live).answers;
  let bought = opts.bought;
  if (!bought) {
    const marks = markIndex(b.marks ?? {}, b.aliases ?? {}, live).marks;
    bought = (k) => !!boughtInfo(marks.get(k)?.bought);
  }
  const set = rulesAt(b.settings as unknown as RuleSet[], opts.today);
  const rule = localBuyRule(set);
  const localOnly = !!set?.rules.buy_local_only;
  const wants = tripWants(b, answers, bought);
  const stores = new Map(b.stores.filter((s) => !s.retired).map((s) => [s.key, s]));

  const quotesByCard = new Map<string, Quote[]>();
  for (const q of b.quotes) {
    const k = norm(q.card);
    quotesByCard.set(k, [...(quotesByCard.get(k) ?? []), q]);
  }

  // A card goes to its cheapest copy after each store's premium (a favourite's "worth a little more"),
  // then the preferred store, then the easier one to get to.
  const hassle = hassleOrder(b);
  const premiumCents = (o: TripOffer) => Math.max(0, Math.round((o.price - storePremium(b, o.store.key)) * 100));
  const compareOffers = (x: TripOffer, y: TripOffer) =>
    premiumCents(x) - premiumCents(y) ||
    RANK[x.preference] - RANK[y.preference] ||
    hassle.get(x.store.key)! - hassle.get(y.store.key)! ||
    x.store.sort - y.store.sort ||
    cmp(x.store.key, y.store.key);

  const checked = new Set<string>();
  // Every want's in-stock, priced listings at known stores, judged; plus what was seen for the reasons.
  const offersOf = new Map<string, TripOffer[]>();
  const seenOf = new Map<string, { checks: number; unpriced: Quote | null; unknown: boolean }>();
  for (const w of wants) {
    const quotes = quotesByCard.get(norm(w.card)) ?? [];
    const recorded = quotes.filter((q) => q.kind === "market_benchmark" && (q.currency == null || q.currency.toUpperCase() === "USD"));
    const latest = newestChecks(quotes);
    let unpriced: Quote | null = null;
    let unknown = false;
    let checks = 0;
    const offers: TripOffer[] = [];
    for (const q of latest) {
      const store = q.store ? stores.get(q.store) : undefined;
      // Only your stores' own checks count: not a printer's price, a retired store or an unmatched label.
      if (!store || store.kind === "printer") continue;
      checks++;
      checked.add(q.checked);
      if (q.in_stock === false) continue;
      // A check that didn't say whether it's in stock isn't a reason to go: ask the store.
      if (q.in_stock !== true) {
        unknown = true;
        continue;
      }
      // A price in another currency can't be judged by the USD rule or summed with dollars.
      if (q.price == null || (q.currency != null && q.currency.toUpperCase() !== "USD")) {
        unpriced ??= q;
        continue;
      }
      if (foilListing(q.result)) continue; // a plain copy is the rule; a foil isn't one
      const market = offerMarket(q, w.card, recorded, b);
      offers.push({ quote: q, store, preference: storePreference(b, store.key), price: q.price, market, verdict: judge(rule.rule, q.price, market?.usd ?? null) });
    }
    offers.sort(compareOffers);
    offersOf.set(w.id, offers);
    seenOf.set(w.id, { checks, unpriced, unknown });
  }

  const going = opts.stores ? new Set(opts.stores) : null;
  const skipWhy = (s: Store): SkipReason | null =>
    storePreference(b, s.key) === "never" ? "never" : localOnly && s.kind !== "local" ? "not-local" : going && !going.has(s.key) ? "left-out" : null;
  const eligible = (s: Store) => skipWhy(s) == null;
  const needed = wants.filter((w) => w.needed);
  // A "maybe" store is only for needed cards no other store you'll go to has under your rule: for
  // the rest it neither decides the stores nor takes the card.
  const elsewhereToo = new Set(
    needed.filter((w) => (offersOf.get(w.id) ?? []).some((o) => o.verdict === "ok" && eligible(o.store) && o.preference !== "maybe")).map((w) => w.id),
  );
  const usable = (w: Want, o: TripOffer) => o.verdict === "ok" && !(o.preference === "maybe" && elsewhereToo.has(w.id));
  const okAt = (w: Want, keys: Set<string>) => (offersOf.get(w.id) ?? []).filter((o) => usable(w, o) && keys.has(o.store.key));

  // Stores worth searching: eligible ones with a qualifying copy of a needed card. A favourite with
  // one is on every trip; the rest are searched.
  const coverage = new Map<string, Set<string>>();
  for (const w of needed) for (const o of offersOf.get(w.id) ?? []) if (usable(w, o) && eligible(o.store)) {
    coverage.set(o.store.key, (coverage.get(o.store.key) ?? new Set()).add(w.id));
  }
  const byOrder = (x: Store, y: Store) => x.sort - y.sort || cmp(x.key, y.key);
  const covering = [...coverage.keys()].map((k) => stores.get(k)!);
  const favourites = covering.filter((s) => storePreference(b, s.key) === "favorite");
  const ranked = covering
    .filter((s) => storePreference(b, s.key) !== "favorite")
    .sort((x, y) => coverage.get(y.key)!.size - coverage.get(x.key)!.size || RANK[storePreference(b, x.key)] - RANK[storePreference(b, y.key)] || byOrder(x, y));
  // Up to 12 other stores are searched exhaustively, so the trip is exact up to 12 candidates.
  // With more, a greedy cover of the cards the favourites don't have (the store adding the most
  // not yet covered, ties in this ranking) picks the stores searched first, then the ranking fills
  // the rest; a cover longer than 12 puts its later stores on every trip. Every coverable card
  // stays reachable, but the fewest stores is approximate there.
  let pool = ranked;
  let forced: Store[] = [...favourites];
  if (ranked.length > MAX_SEARCH) {
    const left = new Set(ranked.flatMap((s) => [...coverage.get(s.key)!]));
    for (const f of favourites) for (const id of coverage.get(f.key)!) left.delete(id);
    const rest = [...ranked];
    const cover: Store[] = [];
    while (left.size) {
      let bestAt = -1;
      let bestN = 0;
      rest.forEach((s, i) => {
        const n = [...coverage.get(s.key)!].filter((id) => left.has(id)).length;
        if (n > bestN) [bestAt, bestN] = [i, n];
      });
      if (bestAt < 0) break;
      const [s] = rest.splice(bestAt, 1);
      cover.push(s!);
      for (const id of coverage.get(s!.key)!) left.delete(id);
    }
    forced = [...favourites, ...cover.slice(MAX_SEARCH)];
    pool = [...cover.slice(0, MAX_SEARCH), ...rest].slice(0, MAX_SEARCH);
  }
  pool = [...pool].sort(byOrder);
  forced.sort(byOrder);

  // Every subset (with the favourites): cards covered, then fewer "maybe" stores, then the easier
  // stores to get to (the sum of their places in your order), then the lower total, then store order.
  // The best of each size is an alternative.
  interface Choice { keys: string[]; covered: number; maybes: number; hassle: number; total: number }
  const best = new Map<number, Choice>();
  const better = (a: Choice, c: Choice) =>
    a.covered !== c.covered ? a.covered > c.covered : a.maybes !== c.maybes ? a.maybes < c.maybes : a.hassle !== c.hassle ? a.hassle < c.hassle : Math.abs(a.total - c.total) > EPS ? a.total < c.total : a.keys.join("|") < c.keys.join("|");
  for (let mask = forced.length ? 0 : 1; mask < 1 << pool.length; mask++) {
    const keys = [...forced, ...pool.filter((_, i) => mask & (1 << i))].sort(byOrder).map((s) => s.key);
    const set = new Set(keys);
    let covered = 0;
    let total = 0;
    for (const w of needed) {
      const o = okAt(w, set)[0];
      if (o) {
        covered++;
        total += o.price;
      }
    }
    const c: Choice = {
      keys,
      covered,
      maybes: keys.filter((k) => storePreference(b, k) === "maybe").length,
      hassle: keys.reduce((n, k) => n + hassle.get(k)!, 0),
      total: cents(total),
    };
    const cur = best.get(keys.length);
    if (!cur || better(c, cur)) best.set(keys.length, c);
  }
  const sizes = [...best.keys()].sort((x, y) => x - y);
  const most = Math.max(0, ...[...best.values()].map((c) => c.covered));
  const alternatives: TripAlternative[] = [];
  let last = -1;
  for (const n of sizes) {
    const c = best.get(n)!;
    if (c.covered <= last) continue; // one more store that adds nothing isn't an alternative
    alternatives.push({ stores: c.keys, covered: c.covered, total: c.total });
    last = c.covered;
    if (c.covered === most) break;
  }
  const chosen = new Set(alternatives[alternatives.length - 1]?.stores ?? []);

  // Assign each card to its cheapest qualifying copy among the chosen stores.
  const stopRows = new Map<string, { rows: TripRow[]; along: TripRow[] }>([...chosen].map((k) => [k, { rows: [], along: [] }]));
  const print: PrintRow[] = [];
  const elsewhere = new Map<string, TripRow[]>();
  for (const w of wants) {
    const offers = offersOf.get(w.id) ?? [];
    const here = okAt(w, chosen)[0];
    if (here) {
      stopRows.get(here.store.key)![w.needed ? "rows" : "along"].push({ want: w, offer: here });
      continue;
    }
    if (!w.needed) {
      const there = offers.find((o) => o.verdict === "ok" && eligible(o.store));
      if (there) elsewhere.set(there.store.key, [...(elsewhere.get(there.store.key) ?? []), { want: w, offer: there }]);
      continue;
    }
    // Off this trip: first the stores you left off today, then ones that aren't local when the rule
    // says buy local, then ones you won't go to.
    const off = offers.filter((o) => o.verdict === "ok" && !eligible(o.store));
    const why = (["left-out", "not-local", "never"] as const).find((r) => off.some((o) => skipWhy(o.store) === r));
    const banned = why ? off.filter((o) => skipWhy(o.store) === why) : [];
    const firstOf = (v: Verdict) => offers.find((o) => o.verdict === v && eligible(o.store)) ?? null;
    const seen = seenOf.get(w.id)!;
    if (why) print.push({ want: w, reason: why === "never" ? "never-store" : why, offer: banned[0]!, stores: [...new Set(banned.map((o) => o.store.name))] });
    else if (firstOf("over-market") || firstOf("no-market") || firstOf("over-max")) {
      const o = (firstOf("over-market") ?? firstOf("no-market") ?? firstOf("over-max"))!;
      print.push({ want: w, reason: o.verdict as PrintReason, offer: o, stores: [] });
    } else if (seen.unpriced) print.push({ want: w, reason: "no-price", offer: null, stores: [] });
    else if (seen.unknown) print.push({ want: w, reason: "unknown-stock", offer: null, stores: [] });
    else print.push({ want: w, reason: seen.checks ? "not-stocked" : "no-check", offer: null, stores: [] });
  }

  const byCard = (x: TripRow, y: TripRow) => cmp(x.want.deckName ?? "", y.want.deckName ?? "") || cmp(x.want.card, y.want.card);
  const stops: TripStop[] = [...chosen]
    .map((k) => stores.get(k)!)
    .sort((x, y) => RANK[storePreference(b, x.key)] - RANK[storePreference(b, y.key)] || hassle.get(x.key)! - hassle.get(y.key)! || byOrder(x, y))
    .map((store) => {
      const { rows, along } = stopRows.get(store.key)!;
      rows.sort(byCard);
      along.sort(byCard);
      const lines = rows.map((r) => r.offer.quote.variant).filter((v): v is string => !!v);
      return {
        store,
        preference: storePreference(b, store.key),
        rows,
        along,
        total: cents(rows.reduce((n, r) => n + r.offer.price, 0)),
        alongTotal: cents(along.reduce((n, r) => n + r.offer.price, 0)),
        cartUrl: cartUrl(store, lines),
        noCartLine: rows.length - lines.length,
        paste: pasteText(rows.map((r) => r.want.card)),
        search: rows.flatMap((r) => {
          const url = proSearchUrl(store, r.want.card);
          return url ? [{ card: r.want.card, url }] : [];
        }),
      };
    });
  const covered = stops.reduce((n, s) => n + s.rows.length, 0);
  print.sort((x, y) => cmp(x.want.deckName ?? "", y.want.deckName ?? "") || cmp(x.want.card, y.want.card));

  const skipped = [...stores.values()]
    .filter((s) => !eligible(s) && s.kind !== "printer")
    .map((store) => ({
      store,
      preference: storePreference(b, store.key),
      cards: needed.filter((w) => (offersOf.get(w.id) ?? []).some((o) => o.verdict === "ok" && o.store.key === store.key)).length,
      why: skipWhy(store)!,
    }))
    .filter((s) => s.cards > 0)
    .sort((x, y) => x.store.sort - y.store.sort || cmp(x.store.key, y.store.key));

  return {
    today: opts.today,
    rule,
    stops,
    needed: needed.length,
    covered,
    total: covered ? cents(stops.reduce((n, s) => n + s.total, 0)) : null,
    alternatives,
    print,
    printPaste: pasteText(print.map((p) => p.want.card)),
    printMassEntry: massEntryUrl(print.map((p) => p.want.card)),
    elsewhere: [...elsewhere]
      .map(([k, rows]) => ({ store: stores.get(k)!, preference: storePreference(b, k), rows: rows.sort(byCard) }))
      .sort((x, y) => x.store.sort - y.store.sort || cmp(x.store.key, y.store.key)),
    skipped,
    going: opts.stores ? [...opts.stores] : null,
    checkedOn: [...checked].sort(),
    wishlist: wishTiers(wishWants(b), b),
  };
}

/** Every card on your real-card wishlist once, also those the plan buys or proposes now. */
function wishWants(b: TripData): Want[] {
  const seen = new Set<string>();
  const out: Want[] = [];
  for (const w of b.wishlist ?? []) {
    if (seen.has(norm(w.card))) continue;
    seen.add(norm(w.card));
    out.push({ id: `wish:${w.card}`, card: w.card, source: "wishlist", needed: false, deck: null, deckName: null, replaces: null, decision: null, reason: w.reason });
  }
  return out;
}

/** Price tiers for the wishlist, by the cheapest non-foil market. */
export const WISH_TIERS: { label: string; min: number }[] = [
  { label: "$200 and up", min: 200 },
  { label: "$50 to $200", min: 50 },
  { label: "$10 to $50", min: 10 },
  { label: "$2 to $10", min: 2 },
  { label: "Under $2", min: 0 },
];

export function wishTiers(wants: Want[], p: PriceData): WishTier[] {
  const tiers: WishTier[] = [...WISH_TIERS.map((t) => ({ label: t.label, items: [] as WishTier["items"], market: null as number | null })), { label: "No market price", items: [], market: null }];
  for (const want of wants) {
    const market = cheapestMarket(want.card, p);
    const i = market ? WISH_TIERS.findIndex((t) => market.usd >= t.min) : WISH_TIERS.length;
    tiers[i]!.items.push({ want, market });
  }
  for (const t of tiers) {
    t.items.sort((x, y) => (y.market?.usd ?? -1) - (x.market?.usd ?? -1) || cmp(x.want.card, y.want.card));
    const known = t.items.filter((x) => x.market);
    t.market = known.length ? cents(known.reduce((n, x) => n + x.market!.usd, 0)) : null;
  }
  return tiers.filter((t) => t.items.length);
}

/** A compact form for comparing with the Rust port (fixtures/trip.json). */
export function tripSummary(t: TripPlan) {
  return {
    rule_from: t.rule.from,
    derived: t.rule.derived,
    stops: t.stops.map((s) => ({
      store: s.store.key,
      rows: s.rows.map((r) => [r.want.card, r.offer.price]),
      along: s.along.map((r) => [r.want.card, r.offer.price]),
      total: s.total,
    })),
    needed: t.needed,
    covered: t.covered,
    total: t.total,
    alternatives: t.alternatives.map((a) => [a.stores, a.covered, a.total]),
    print: t.print.map((p) => [p.want.card, p.reason]),
    print_mass_entry: t.printMassEntry,
    search: t.stops.map((s) => s.search.map((x) => x.url)),
    elsewhere: t.elsewhere.map((e) => [e.store.key, e.rows.map((r) => r.want.card)]),
    skipped: t.skipped.map((s) => [s.store.key, s.cards, s.why]),
    wishlist: t.wishlist.map((w) => [w.label, w.items.map((i) => i.want.card)]),
  };
}

