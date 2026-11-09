// The Cards tab's list (deck page SPEC 1b, board Deck): which cards show (Whole deck, Still need,
// Proxies), how they group (Type, Mana value, None) and sort (Mana value, Name, Price), and each
// group's count and price. A missing price stays missing: subtotals count known prices only and
// say how many have none.
import { GROUP_ORDER, groupOf } from "@yama/core";
import type { DeckEntry } from "../api";

export type CardShow = "all" | "need" | "proxy";
export type CardGroupBy = "type" | "mv" | "none";
export type CardSort = "mv" | "name" | "price";

export interface CardRow {
  key: string;
  entry: DeckEntry;
  /** Copies in the deck, and how many are real, proxies, or neither. */
  qty: number;
  real: number;
  proxy: number;
  need: number;
  mv: number;
  type: string;
}

export function cardRows(cards: DeckEntry[]): CardRow[] {
  return cards
    .filter((e) => e.qty > 0)
    .map((e) => {
      const real = Math.min(e.qty, e.owned);
      const proxy = Math.min(e.qty - real, e.proxies);
      return { key: `${e.oracle_id}-${e.board}`, entry: e, qty: e.qty, real, proxy, need: Math.max(0, e.qty - real - proxy), mv: e.card?.cmc ?? 0, type: groupOf(e.board, e.card?.type_line) };
    });
}

/** Copies of a row that the filter counts. */
export function copiesShown(r: CardRow, show: CardShow): number {
  return show === "need" ? r.need : show === "proxy" ? r.proxy : r.qty;
}

export function showCounts(rows: CardRow[]): Record<CardShow, number> {
  const sum = (show: CardShow) => rows.reduce((a, r) => a + copiesShown(r, show), 0);
  return { all: sum("all"), need: sum("need"), proxy: sum("proxy") };
}

const mvGroup = (r: CardRow) => (r.type === "Commander" || r.type === "Lands" || r.type === "Sideboard" ? r.type : r.mv >= 7 ? "7 or more" : `Mana value ${r.mv}`);
const MV_ORDER = ["Commander", ...[0, 1, 2, 3, 4, 5, 6].map((n) => `Mana value ${n}`), "7 or more", "Lands", "Sideboard"];

function sorter(sort: CardSort) {
  const name = (a: CardRow, b: CardRow) => a.entry.name.localeCompare(b.entry.name);
  if (sort === "name") return name;
  if (sort === "price")
    return (a: CardRow, b: CardRow) => {
      const pa = a.entry.cheapest_usd;
      const pb = b.entry.cheapest_usd;
      if (pa == null || pb == null) return pa == null && pb == null ? name(a, b) : pa == null ? 1 : -1;
      return pb - pa || name(a, b);
    };
  return (a: CardRow, b: CardRow) => a.mv - b.mv || name(a, b);
}

export interface CardGroup {
  id: string;
  title: string;
  rows: CardRow[];
  /** Copies shown in the group. */
  count: number;
  /** Known prices only (each copy at its cheapest printing); null when none has a price. */
  usd: number | null;
  unpriced: number;
}

export function priceOf(rows: CardRow[], show: CardShow): { usd: number | null; unpriced: number } {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of rows) {
    const n = copiesShown(r, show);
    if (!n) continue;
    if (r.entry.cheapest_usd == null) unpriced += n;
    else {
      usd += r.entry.cheapest_usd * n;
      priced += n;
    }
  }
  return { usd: priced ? Math.round(usd * 100) / 100 : null, unpriced };
}

/** The groups to show, in order, each sorted; a filter drops cards it doesn't count. */
export function cardGroups(rows: CardRow[], show: CardShow, groupBy: CardGroupBy, sort: CardSort): CardGroup[] {
  const shown = rows.filter((r) => copiesShown(r, show) > 0);
  const keyOf = groupBy === "type" ? (r: CardRow) => r.type : groupBy === "mv" ? mvGroup : () => "All cards";
  const order = groupBy === "type" ? GROUP_ORDER : groupBy === "mv" ? MV_ORDER : ["All cards"];
  const map = new Map<string, CardRow[]>();
  for (const r of shown) map.set(keyOf(r), [...(map.get(keyOf(r)) ?? []), r]);
  const by = sorter(sort);
  return [...map.keys()]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((title) => {
      const rs = map.get(title)!.sort(by);
      const p = priceOf(rs, show);
      return { id: `g-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title, rows: rs, count: rs.reduce((a, r) => a + copiesShown(r, show), 0), ...p };
    });
}

/** "1 Sol Ring" lines for what's shown, under Commander, Deck and Sideboard. */
export function shownText(rows: CardRow[], show: CardShow): string {
  const section = (title: string, board: string) => {
    const lines = rows.filter((r) => r.entry.board === board && copiesShown(r, show) > 0).map((r) => `${copiesShown(r, show)} ${r.entry.name}`);
    return lines.length ? [title, ...lines, ""] : [];
  };
  return [...section("Commander", "commander"), ...section("Deck", "main"), ...section("Sideboard", "side")].join("\n").trim();
}
