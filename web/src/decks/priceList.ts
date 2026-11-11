import { type CheapestPrinting, type DeckEntry, type PrintRef } from "../api";
import { GROUP_ORDER, groupOf, shortDate, usd } from "@yama/core";
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

/** Nothing in the total has a price because it is all basics left out of still need: say how
 *  many cards, without a "No price" that isn't true. */
export function onlyBasics(t: PriceTotal): boolean {
  return t.usd == null && t.unpriced === 0 && t.basics > 0;
}

/** What a total leaves uncounted: " (1 without a price, 2 basic lands not counted)", or "". */
export function totalNote(t: PriceTotal): string {
  const notes = [t.unpriced ? `${t.unpriced} without a price` : "", t.basics ? `${t.basics} basic ${t.basics === 1 ? "land" : "lands"} not counted` : ""].filter(Boolean);
  return notes.length ? ` (${notes.join(", ")})` : "";
}

/** The newest price date among the rows, and the oldest (YYYY-MM-DD). */
export function priceDates(rows: PriceRow[]): { oldest: string | null; newest: string | null } {
  const dates = rows.map((r) => r.cheapest?.date).filter((d): d is string => !!d).sort();
  return { oldest: dates[0] ?? null, newest: dates[dates.length - 1] ?? null };
}

/** Where the prices come from with their dates: one date, or the range when cards differ. */
export function priceSourceLine(rows: PriceRow[], fallback: string | null | undefined): string {
  const { oldest, newest } = priceDates(rows);
  const last = shortDate(newest ?? fallback);
  if (!last) return "TCGplayer market via Scryfall, date unknown";
  return oldest && oldest !== newest ? `TCGplayer market via Scryfall, ${shortDate(oldest)} to ${last}` : `TCGplayer market via Scryfall, ${last}`;
}

/** A card priced on an earlier day than the newest names its own date: "Nov 4". */
export function olderDate(r: PriceRow, newest: string | null): string | null {
  const d = r.cheapest?.date;
  return d && newest && d < newest ? shortDate(d) : null;
}

/** "Plateau (3ED 283)". */
export function printingLabel(p: { set_code: string; collector_number: string }): string {
  return `${p.set_code.toUpperCase()} ${p.collector_number}`;
}

/** ", proxy" or ", not owned" for a card that is all one kind ("" when all real); a card split
 *  between kinds counts each, ", 8 real, 1 proxy, 2 not owned". */
export function kindText(r: PriceRow): string {
  const parts = ([[r.real, "real"], [r.proxy, r.proxy === 1 ? "proxy" : "proxies"], [r.need, "not owned"]] as const).filter(([n]) => n > 0);
  if (parts.length > 1) return `, ${parts.map(([n, w]) => `${n} ${w}`).join(", ")}`;
  return r.proxy ? ", proxy" : r.need ? ", not owned" : "";
}

/** The view as plain text to paste in a chat: one line a card, priciest first, then the total. */
export function priceText(rows: PriceRow[], show: PriceShow, date: string, left?: { groups: string[]; rows: PriceRow[] }): string {
  const { newest } = priceDates(rows);
  const lines = rows.map((r) => {
    const older = olderDate(r, newest);
    const n = copiesIn(r, show);
    const kind = show === "all" ? kindText(r) : "";
    const price = r.each == null ? "no price" : n > 1 ? `${usd(r.each * n)} (${usd(r.each)} each)` : usd(r.each);
    const where = r.cheapest ? ` at ${r.cheapest.set_name} (${printingLabel(r.cheapest)})` : "";
    return `${n} ${r.name}${kind}: ${price}${where}${older ? `, price from ${older}` : ""}`;
  });
  const t = priceTotal(rows, show);
  lines.push("", `Total: ${usd(t.usd)} for ${t.copies} ${t.copies === 1 ? "card" : "cards"}${totalNote(t)}.`);
  if (left && left.groups.length > 0) {
    const l = priceTotal(left.rows, show);
    lines.push(`Left out: ${groupList(left.groups)}, ${onlyBasics(l) ? "" : `${usd(l.usd)} for `}${l.copies} ${l.copies === 1 ? "card" : "cards"}${totalNote(l)}.`);
  }
  lines.push(`Cheapest nonfoil paper printing of each card, ${date}. Market prices, not store quotes.`);
  return lines.join("\n");
}
