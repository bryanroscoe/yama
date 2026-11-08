import { usd, type CheapestPrinting, type DeckEntry, type PrintRef } from "../api";
import { GROUP_ORDER, groupOf } from "@yama/core";
import { isBasic } from "./deckScan";

/** The deck page's Prices view: every card with what its cheapest printing costs, and whether
 *  the deck plays a real copy, a proxy or neither yet. Commander and main deck only. */

export type PriceShow = "all" | "proxy" | "real" | "need";
export type PriceSort = "price" | "name";

export interface PriceRow {
  key: string;
  oracle_id: string;
  name: string;
  entry: DeckEntry;
  qty: number;
  /** Copies the deck plays as real cards, as proxies, and copies neither covers. */
  real: number;
  proxy: number;
  need: number;
  /** The cheapest printing's market price for one copy; null when no printing has a price. */
  each: number | null;
  cheapest: CheapestPrinting | null;
  /** The printing of your own copy, when you have one. */
  yours: PrintRef | null;
  basic: boolean;
  /** The deck page's group: Commander, Creatures, Lands and so on (the front face decides). */
  group: string;
}

/** Same split as the server's totals: real copies first, then proxies, then what's missing. */
export function priceRows(cards: DeckEntry[]): PriceRow[] {
  return cards
    .filter((e) => e.board !== "side" && e.qty > 0)
    .map((e) => {
      const real = Math.min(e.qty, e.owned);
      const proxy = Math.min(e.qty - real, e.proxies);
      return {
        key: `${e.oracle_id}-${e.board}`,
        oracle_id: e.oracle_id,
        name: e.name,
        entry: e,
        qty: e.qty,
        real,
        proxy,
        need: e.qty - real - proxy,
        each: e.cheapest_usd,
        cheapest: e.cheapest_printing ?? null,
        yours: e.printing?.from === "owned" ? e.printing : null,
        basic: isBasic(e.name),
        group: groupOf(e.board, e.card?.type_line),
      };
    });
}

/** Copies of a row that count in a view. */
export function copiesIn(r: PriceRow, show: PriceShow): number {
  return show === "all" ? r.qty : r[show];
}

/** What counts toward a view's total: basics stay out of "still need", as on the deck's figures. */
const counts = (r: PriceRow, show: PriceShow) => !(show === "need" && r.basic);

export function shownRows(rows: PriceRow[], show: PriceShow, sort: PriceSort): PriceRow[] {
  const byName = (a: PriceRow, b: PriceRow) => a.name.localeCompare(b.name);
  return rows
    .filter((r) => copiesIn(r, show) > 0)
    .sort(sort === "name" ? byName : (a, b) => {
      // Highest first; a card with no price goes last, never counted as $0.
      if (a.each == null || b.each == null) return a.each == null && b.each == null ? byName(a, b) : a.each == null ? 1 : -1;
      return b.each - a.each || byName(a, b);
    });
}

export interface PriceTotal {
  /** Sum of the copies that have a price; null when none does (unknown, not $0). */
  usd: number | null;
  copies: number;
  unpriced: number;
  /** Basic lands left out of the total ("still need" only). */
  basics: number;
}

export function priceTotal(rows: PriceRow[], show: PriceShow): PriceTotal {
  const t: PriceTotal = { usd: null, copies: 0, unpriced: 0, basics: 0 };
  let cents = 0;
  for (const r of rows) {
    const n = copiesIn(r, show);
    if (n === 0) continue;
    t.copies += n;
    if (!counts(r, show)) t.basics += n;
    else if (r.each == null) t.unpriced += n;
    else {
      cents += Math.round(r.each * 100) * n;
      t.usd = cents / 100;
    }
  }
  return t;
}

/** The deck's groups in page order, to leave some out of the prices. */
export function groupsIn(rows: PriceRow[]): string[] {
  const present = new Set(rows.map((r) => r.group));
  return GROUP_ORDER.filter((g) => present.has(g));
}

/** Rows split into those kept and those in a group left out. */
export function leaveOut(rows: PriceRow[], out: ReadonlySet<string>): { kept: PriceRow[]; left: PriceRow[] } {
  return { kept: rows.filter((r) => !out.has(r.group)), left: rows.filter((r) => out.has(r.group)) };
}

/** "Lands and Artifacts". */
export function groupList(groups: string[]): string {
  return groups.length <= 1 ? groups.join("") : `${groups.slice(0, -1).join(", ")} and ${groups[groups.length - 1]}`;
}

/** "Plateau (3ED 283)". */
export function printingLabel(p: { set_code: string; collector_number: string }): string {
  return `${p.set_code.toUpperCase()} ${p.collector_number}`;
}

/** The view as plain text to paste in a chat: one line a card, priciest first, then the total. */
export function priceText(rows: PriceRow[], show: PriceShow, date: string, left?: { groups: string[]; rows: PriceRow[] }): string {
  const lines = rows.map((r) => {
    const n = copiesIn(r, show);
    const kind = show !== "all" ? "" : r.proxy && !r.real && !r.need ? ", proxy" : r.proxy ? `, ${r.proxy} proxied` : r.need === r.qty ? ", not owned" : "";
    const price = r.each == null ? "no price" : n > 1 ? `${usd(r.each * n)} (${usd(r.each)} each)` : usd(r.each);
    const where = r.cheapest ? ` at ${r.cheapest.set_name} (${printingLabel(r.cheapest)})` : "";
    return `${n} ${r.name}${kind}: ${price}${where}`;
  });
  const t = priceTotal(rows, show);
  const missing = [t.unpriced ? `${t.unpriced} without a price` : "", t.basics ? `${t.basics} basic lands left out` : ""].filter(Boolean).join(", ");
  lines.push("", `Total: ${usd(t.usd)} for ${t.copies} ${t.copies === 1 ? "card" : "cards"}${missing ? ` (${missing})` : ""}.`);
  if (left && left.groups.length > 0) {
    const l = priceTotal(left.rows, show);
    lines.push(`Left out: ${groupList(left.groups)}, ${usd(l.usd)} for ${l.copies} ${l.copies === 1 ? "card" : "cards"}${l.unpriced ? ` (${l.unpriced} without a price)` : ""}.`);
  }
  lines.push(`Cheapest nonfoil paper printing of each card, ${date}. Market prices, not store quotes.`);
  return lines.join("\n");
}
