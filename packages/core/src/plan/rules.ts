// The owner's shopping rules, dated (docs/planner-design.md section 9), and the price flags they
// produce. Rules only ever flag: nothing is blocked or hidden. A price is judged by the rule set in
// force on the day it was checked (or paid), so an early purchase isn't held to a later ceiling.
//
// Market prices come from Yama's price data (TCGplayer market via Scryfall) or from a benchmark the
// plan recorded; every comparison says which one it used and its date. A price older than the rest
// of Yama's prices is said to be old, never shown as today's.

import { fmtDate, usd } from "../format";
import type { PlanBundle, Quote, Store } from "./types";

/** Every rule is optional; a rule that isn't set produces no flag. */
export interface Rules {
  currency?: string;
  market_source?: string;
  compare_to?: string;
  buy_local_only?: boolean;
  max_over_market_pct?: number;
  avoid_pricey_printing?: boolean;
  always_print_over_usd?: number;
  shiny_only_if_no_plain?: boolean;
  budget_substitutes_ok?: boolean;
  ceiling_key_usd?: number;
  ceiling_other_usd?: number;
  ceiling_other_note?: string;
  allow_standins?: boolean;
  spares_first?: boolean;
  proxy_cost_usd?: number;
  proxy_cost_note?: string;
  /** Points the owner hasn't settled yet, shown next to the flags. */
  needs_confirmation?: string[];
  /** Which local listings are worth buying, for the store trip (trip.ts `LocalBuyRule`). */
  local_buy?: { max_usd?: number | null; always_ok_usd?: number | null; tiers?: { market_under?: number | null; max_multiple: number }[] };
  /** The most to pay for a sealed precon, per deck, before tax. */
  sealed_max_usd?: number | null;
}

export interface RuleSet {
  effective_from: string;
  rules: Rules;
  note: string | null;
  origin: string;
}

/** "2026-10-19": a date as plans write it, in this device's time zone. */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

/** Whole days from `a` to `b` (both YYYY-MM-DD, or timestamps); null when either is missing. */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = day(a);
  const y = day(b);
  if (!x || !y) return null;
  return Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / 86_400_000);
}

/**
 * The rule set in force on `date`: the newest one that starts on or before it. With no date, the
 * newest set. Null when no set had started yet, which means no flags.
 */
export function rulesAt(settings: RuleSet[], date: string | null | undefined): RuleSet | null {
  const sorted = [...settings].sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0));
  const d = day(date);
  if (!d) return sorted[sorted.length - 1] ?? null;
  let found: RuleSet | null = null;
  for (const s of sorted) if (s.effective_from <= d) found = s;
  return found;
}

// ── market prices ──────────────────────────────────────────────────────────

/** A price is old when it is this many days older than Yama's newest price. */
export const STALE_DAYS = 3;

export interface MarketBasis {
  usd: number;
  /** The snapshot's date; null only for a recorded benchmark with no date. */
  date: string | null;
  source: string;
  /** What it is: the listing's own printing, the cheapest non-foil copy, or the plan's recorded benchmark. */
  kind: "printing" | "cheapest" | "recorded";
  /** "2X2 #173" or "Forgotten Realms Commander (AFC) #175". */
  printing: string | null;
  /** Which printing the price is for, when known: to tell whether two prices are for the same copy. */
  ref: PrintingRef | null;
  /** Older than Yama's other prices by more than STALE_DAYS: shown as "last priced". */
  stale: boolean;
}

export type PriceData = Pick<PlanBundle, "market" | "market_by_printing" | "printing_ids" | "names" | "prices_as_of">;

/** Whether a price dated `date` is old next to Yama's newest price (`asOf`). */
export function isStale(date: string | null | undefined, asOf: string | null | undefined): boolean {
  const gap = daysBetween(date, asOf);
  return gap != null && gap > STALE_DAYS;
}

/** "$0.53 for 2X2 #173, Oct 19, 2026" or "…, last priced Jul 2, 2026", for inside a sentence. */
export function basisText(m: MarketBasis): string {
  const what = m.printing ? ` for ${m.printing}` : "";
  const when = m.date ? (m.stale ? `, last priced ${fmtDate(m.date)}` : `, ${fmtDate(m.date)}`) : ", date not recorded";
  return `${usd(m.usd)}${what}${when}`;
}

/** Yama's cheapest non-foil market price for a card, or null. */
export function cheapestMarket(card: string | null | undefined, p: PriceData): MarketBasis | null {
  const id = card ? p.names[card.trim()] : undefined;
  const m = id ? p.market[id] : null;
  if (!m) return null;
  return {
    usd: m.usd,
    date: m.date,
    source: m.source,
    kind: "cheapest",
    printing: m.printing,
    ref: { scryfall_id: m.scryfall_id, set: m.set, num: m.num },
    stale: isStale(m.date, p.prices_as_of),
  };
}

export interface PrintingRef {
  scryfall_id?: string | null;
  set?: string | null;
  num?: string | null;
}

/** Yama's market price for one printing (non-foil, or foil when asked), or null. */
export function printingMarket(ref: PrintingRef | null | undefined, p: PriceData, foil = false): MarketBasis | null {
  if (!ref) return null;
  const id = ref.scryfall_id || (ref.set && ref.num ? p.printing_ids[`${ref.set.toLowerCase()}/${ref.num}`] : undefined);
  const m = id ? p.market_by_printing[id] : undefined;
  const v = m ? (foil ? m.usd_foil : m.usd) : null;
  if (!m || v == null) return null;
  return {
    usd: v,
    date: m.date,
    source: m.source,
    kind: "printing",
    printing: `${m.set.toUpperCase()} #${m.num}${foil ? " foil" : ""}`,
    ref: { scryfall_id: id, set: m.set, num: m.num },
    stale: isStale(m.date, p.prices_as_of),
  };
}

/**
 * Whether two references name the same printing: by Scryfall id when both have one, else by set
 * and collector number. False when either side doesn't say.
 */
export function samePrinting(a: PrintingRef | null | undefined, b: PrintingRef | null | undefined, p?: Pick<PriceData, "printing_ids">): boolean {
  if (!a || !b) return false;
  const id = (r: PrintingRef) => r.scryfall_id || (p && r.set && r.num ? p.printing_ids[`${r.set.toLowerCase()}/${r.num}`] : undefined) || null;
  const x = id(a);
  const y = id(b);
  if (x && y) return x === y;
  return !!(a.set && a.num && b.set && b.num) && a.set.toLowerCase() === b.set.toLowerCase() && a.num === b.num;
}

/** The newest recorded benchmark among these quotes, as a basis. */
export function recordedMarket(quotes: Quote[] | undefined, asOf: string | null | undefined): MarketBasis | null {
  const q = (quotes ?? []).filter((x) => x.kind === "market_benchmark" && x.price != null).sort((a, b) => (a.checked < b.checked ? 1 : -1))[0];
  if (!q || q.price == null) return null;
  const ref = q.scryfall_id || (q.set && q.num) ? { scryfall_id: q.scryfall_id, set: q.set, num: q.num } : null;
  return { usd: q.price, date: q.checked, source: q.source, kind: "recorded", printing: q.printing, ref, stale: isStale(q.checked, asOf) };
}

// ── what a listing says about itself ───────────────────────────────────────

/** Words that mark a foil or special version in a listing ("non-foil" doesn't count). */
const SPECIAL = /\b(foil|etched|borderless|showcase|extended art|full art|textured|serialized|galaxy|surge)\b/i;

/** The special-version word in a listing, or null for a plain copy. */
export function specialVersion(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = SPECIAL.exec(text.replace(/\bnon-?foil\b/gi, ""));
  return m ? m[1]!.toLowerCase() : null;
}

// ── flags ──────────────────────────────────────────────────────────────────

export interface PriceFlag {
  id: "no-price" | "no-rules" | "no-market" | "over-market" | "pricey-printing" | "special" | "print-over" | "ceiling-key" | "ceiling-other" | "not-local";
  text: string;
  tone: "warn" | "plain";
}

export interface PriceCheckInput {
  card: string;
  /** Listed or paid, for one copy. Null when there is none. */
  price: number | null;
  /** When it was listed (the stock check) or paid. Picks the rule set. */
  date: string | null;
  store?: Store | null;
  /** The listing's text, to spot a foil or special version. */
  text?: string | null;
  printing?: PrintingRef | null;
  /** The plan's recorded benchmarks for this card. */
  recorded?: Quote[];
  /** Compare with market prices. Off for past purchases: today's market isn't the market they were bought at. */
  compareMarket?: boolean;
}

export interface PriceCheck {
  rules: RuleSet | null;
  /** What the price was compared with: its own printing first, else the cheapest non-foil copy. */
  basis: MarketBasis | null;
  cheapest: MarketBasis | null;
  /** Percent over (negative: under) the basis, rounded. */
  overPct: number | null;
  flags: PriceFlag[];
}

/**
 * Judge a price by the rules in force on its date. Compares with the listing's own printing (Yama's
 * price for it), otherwise the cheapest non-foil copy (Yama's, else the plan's recorded benchmark),
 * and says which one. With no market price there's no over-market flag, only a note saying so.
 */
export function priceFlag(input: PriceCheckInput, prices: PriceData, settings: RuleSet[]): PriceCheck {
  const rules = rulesAt(settings, input.date);
  const r = rules?.rules ?? {};
  const flags: PriceFlag[] = [];
  const special = specialVersion(input.text);
  const compare = input.compareMarket !== false;
  const own = compare ? printingMarket(input.printing, prices, special === "foil" || special === "etched") : null;
  const cheapest = compare ? cheapestMarket(input.card, prices) ?? recordedMarket(input.recorded, prices.prices_as_of) : null;
  const basis = own ?? cheapest;
  const price = input.price;
  const overPct = price != null && basis && basis.usd > 0 ? Math.round((price / basis.usd - 1) * 100) : null;
  const old = (m: MarketBasis) => (m.stale ? " That market price is older than the rest of Yama's prices." : "");

  if (price == null) {
    flags.push({ id: "no-price", text: "No listed price, so the rules can't be checked.", tone: "plain" });
    return { rules, basis, cheapest, overPct, flags };
  }
  if (!rules) {
    flags.push({ id: "no-rules", text: `No shopping rules were in force on ${fmtDate(input.date) || "that date"}.`, tone: "plain" });
    return { rules, basis, cheapest, overPct, flags };
  }
  if (compare && r.max_over_market_pct != null) {
    if (!basis) flags.push({ id: "no-market", text: "No market price to compare.", tone: "plain" });
    else if (overPct != null && overPct > r.max_over_market_pct) {
      const what = basis.kind === "printing" ? "the market for that printing" : basis.kind === "cheapest" ? "the cheapest non-foil market" : "the recorded market";
      flags.push({
        id: "over-market",
        text: `${overPct}% over ${what} (${basisText(basis)}); your limit is ${r.max_over_market_pct}%.${old(basis)}`,
        tone: "warn",
      });
    }
  }
  if (compare && r.avoid_pricey_printing && own && cheapest && cheapest.usd < own.usd) {
    const limit = 1 + (r.max_over_market_pct ?? 0) / 100;
    if (price > cheapest.usd * limit) {
      flags.push({ id: "pricey-printing", text: `A pricier printing: the cheapest copy is ${basisText(cheapest)}.${old(cheapest)}`, tone: "warn" });
    }
  }
  // Yama's price data doesn't say which printings are borderless, showcase or extended art, so the
  // cheapest non-foil copy is never called a plain one. A foil or etched listing is a special finish
  // of its printing, so a cheaper non-foil copy of any printing (its own included) counts. A special
  // frame is the printing itself: the flag needs a cheaper copy of a different printing, and stays
  // quiet when the cheapest copy is the listing's own printing (Agent of Treachery, TLE #9 borderless).
  const finishOnly = special === "foil" || special === "etched";
  if (compare && r.shiny_only_if_no_plain && special && cheapest && price > cheapest.usd && (finishOnly || !samePrinting(input.printing, cheapest.ref, prices))) {
    const unsure = finishOnly ? "" : " Yama can't tell whether that printing is a plain one.";
    flags.push({
      id: "special",
      text: `A ${special} version, while the cheapest non-foil copy is ${basisText(cheapest)}.${unsure} Your rule: pay extra for a foil or special version only when there's no plain one.`,
      tone: "plain",
    });
  }
  if (r.always_print_over_usd != null && price > r.always_print_over_usd) {
    flags.push({ id: "print-over", text: `Over ${usd(r.always_print_over_usd)}: your rule says print it.`, tone: "warn" });
  }
  if (r.ceiling_key_usd != null && price > r.ceiling_key_usd) {
    flags.push({ id: "ceiling-key", text: `Over ${usd(r.ceiling_key_usd)}, your limit even for a card that really matters.`, tone: "warn" });
  } else if (r.ceiling_other_usd != null && price > r.ceiling_other_usd) {
    const limit = r.ceiling_key_usd != null ? ` (limit ${usd(r.ceiling_key_usd)})` : "";
    flags.push({ id: "ceiling-other", text: `Above ${r.ceiling_other_note ?? usd(r.ceiling_other_usd)}: fine only if this card really matters${limit}.`, tone: "plain" });
  }
  if (r.buy_local_only && input.store && input.store.kind !== "local") {
    flags.push({ id: "not-local", text: `${input.store.name} isn't a local store; your rule is to buy locally.`, tone: "warn" });
  }
  return { rules, basis, cheapest, overPct, flags };
}
