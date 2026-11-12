import { count } from "@yama/core";
import type { CollectionItem } from "../api";
// The Collection page's filters (set, color, type, rarity, finish) and the totals of what they
// leave. The page has every row of the current view already, so filtering happens on the device.

export interface Filters {
  /** A set code, or "" for any. */
  set: string;
  /** W, U, B, R or G (the card's color identity includes it), "C" (colorless), "M" (two or more), or "". */
  color: string;
  /** A card type as the type line writes it ("Creature"), or "". */
  type: string;
  /** common, uncommon, rare, mythic…, or "". */
  rarity: string;
  /** nonfoil, foil or etched, or "". */
  finish: string;
}

export const NO_FILTERS: Filters = { set: "", color: "", type: "", rarity: "", finish: "" };

export const COLOR_OPTIONS: [string, string][] = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["C", "Colorless"], ["M", "Multicolor"]];
/** The card types offered, in the order players list them. */
const TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land"];
const RARITIES = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
const FINISHES = ["nonfoil", "foil", "etched"];
export const FINISH_LABEL: Record<string, string> = { nonfoil: "Regular", foil: "Foil", etched: "Etched" };

type Row = Pick<CollectionItem, "set_code" | "set_name" | "color_identity" | "type_line" | "rarity" | "finish" | "qty" | "proxy" | "unit_price_usd">;

export function activeFilters(f: Filters): number {
  return Object.values(f).filter(Boolean).length;
}

/** Whether a row passes every filter that is set. A printing Yama doesn't know passes none of the card filters. */
export function passes(i: Row, f: Filters): boolean {
  if (f.set && i.set_code !== f.set) return false;
  if (f.color) {
    if (i.color_identity == null) return false;
    const id = i.color_identity;
    if (f.color === "C" ? id !== "" : f.color === "M" ? id.length < 2 : !id.includes(f.color)) return false;
  }
  if (f.type && !(i.type_line ?? "").includes(f.type)) return false;
  if (f.rarity && i.rarity !== f.rarity) return false;
  if (f.finish && i.finish !== f.finish) return false;
  return true;
}

export interface FilterOptions {
  /** Sets with at least one row, by name. */
  sets: { code: string; name: string }[];
  types: string[];
  rarities: string[];
  finishes: string[];
}

/** What can be chosen: only what the rows in view hold, so no choice leads to an empty list on its own. */
export function filterOptions(items: Row[]): FilterOptions {
  const sets = new Map<string, string>();
  const types = new Set<string>();
  const rarities = new Set<string>();
  const finishes = new Set<string>();
  for (const i of items) {
    if (i.set_code) sets.set(i.set_code, i.set_name ?? i.set_code.toUpperCase());
    for (const t of TYPES) if ((i.type_line ?? "").includes(t)) types.add(t);
    if (i.rarity) rarities.add(i.rarity);
    finishes.add(i.finish);
  }
  return {
    sets: [...sets].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code)),
    types: TYPES.filter((t) => types.has(t)),
    // Known rarities in their order, then anything new Scryfall adds.
    rarities: [...RARITIES.filter((r) => rarities.has(r)), ...[...rarities].filter((r) => !RARITIES.includes(r)).sort()],
    finishes: FINISHES.filter((x) => finishes.has(x)),
  };
}

export interface Totals {
  /** Copies in view, proxies included. */
  copies: number;
  proxies: number;
  /** Market value of the real copies that have a price. */
  value: number;
  /** Real copies with no price: counted, never added in as $0. */
  unpriced: number;
}

export function totals(items: Row[]): Totals {
  const t: Totals = { copies: 0, proxies: 0, value: 0, unpriced: 0 };
  for (const i of items) {
    t.copies += i.qty;
    if (i.proxy) t.proxies += i.qty;
    else if (i.unit_price_usd == null) t.unpriced += i.qty;
    else t.value += i.unit_price_usd * i.qty;
  }
  return t;
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
export const rarityLabel = (r: string) => cap(r);

/** The filters with any choice the rows in view no longer offer taken out (another box was opened, say). */
export function clampFilters(f: Filters, o: FilterOptions): Filters {
  return {
    set: o.sets.some((s) => s.code === f.set) ? f.set : "",
    color: f.color,
    type: o.types.includes(f.type) ? f.type : "",
    rarity: o.rarities.includes(f.rarity) ? f.rarity : "",
    finish: o.finishes.includes(f.finish) ? f.finish : "",
  };
}

/**
 * What the filtered rows add up to: "12 cards match, $340 market value. 2 have no price and
 * aren't counted. 1 proxy isn't counted." `money` formats the value (usdWhole).
 */
export function totalsText(t: Totals, money: (v: number) => string): string {
  const real = t.copies - t.proxies;
  const out = [`${count(t.copies)} ${t.copies === 1 ? "card matches" : "cards match"}${real > t.unpriced ? `, ${money(t.value)} market value` : ""}.`];
  if (t.unpriced) out.push(`${count(t.unpriced)} ${t.unpriced === 1 ? "has" : "have"} no price and ${t.unpriced === 1 ? "isn't" : "aren't"} counted.`);
  if (t.proxies) out.push(`${count(t.proxies)} ${t.proxies === 1 ? "proxy isn't" : "proxies aren't"} counted.`);
  return out.join(" ");
}
