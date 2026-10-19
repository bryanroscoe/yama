// "Sort a delivery": an order's cards A to Z, each with the deck it goes in and what it replaces,
// so a box from a store (or a print order) can be sorted into decks. Real orders also say what the
// newest collection scan found for each copy.

import { priceFlag, type PriceFlag, type PriceData, type RuleSet } from "./rules";
import type { LibraryBought, Order, PlanBundle } from "./types";

export interface DeliveryLine {
  line: number;
  card: string;
  qty: number;
  deck: string | null;
  replaces: string | null;
  role: string | null;
  /** Paid for one copy; null when not recorded. */
  unitPrice: number | null;
  arrived: boolean | null;
  /** The scan's copies of this line (one per copy bought). */
  scans: LibraryBought[];
  /** Judged by the rules in force on the order date, without today's market. */
  flags: PriceFlag[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function deliveryList(order: Order, b: Pick<PlanBundle, "library" | "settings"> & PriceData): DeliveryLine[] {
  const bought = b.library?.bought ?? [];
  const settings = b.settings as unknown as RuleSet[];
  return order.items
    .map((it) => ({
      line: it.line,
      card: it.card,
      qty: it.qty,
      deck: it.deck,
      replaces: it.replaces,
      role: it.role,
      unitPrice: it.unit_price,
      arrived: it.arrived,
      scans: bought.filter((x) => x.order === order.key && x.line === it.line),
      flags:
        order.kind === "real" && it.unit_price != null
          ? priceFlag({ card: it.card, price: it.unit_price, date: order.date_ordered ?? order.placed_by, compareMarket: false }, b, settings).flags
          : [],
    }))
    .sort((x, y) => cmp(x.card.toLowerCase(), y.card.toLowerCase()) || x.line - y.line);
}
