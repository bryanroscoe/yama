import { describe, expect, it } from "vitest";
import type { MarkPair, Order, OrderItem, Swap } from "@yama/core/plan";
import { portfolioRows, type SourceCard, type SourceUse } from "./sourcing-model";
import { coveredLines, withoutOrdered } from "./sourcing-orders";
import type { ResearchDocument } from "../research/api";

// Midday, so the list's day is the same on any machine's calendar.
const LIST = { generated_at: "2026-11-12T12:00:00.000Z" };
const use = (id: string, deck: string, category = "unresolved gameplay source: check before any purchase"): SourceUse => ({ id, deck, deck_name: `Deck ${deck}`, category });
const card = (name: string, uses: SourceUse[]): SourceCard => ({ name, status: "qualifying", uses, offers: [] });
const item = (name: string, qty = 1, deck: string | null = null) => ({ card: name, qty, deck }) as unknown as OrderItem;
const order = (key: string, date_ordered: string | null, items: OrderItem[], over: Partial<Order> = {}) =>
  ({ key, kind: "real", status: "received", vendor: "Pat's Games", order_number: null, date_ordered, items, ...over }) as unknown as Order;
const swap = (key: string, deck: string, name: string, over: Partial<Swap> = {}) => ({ key, deck, in: name, retired: false, order_item: null, ...over }) as unknown as Swap;
const bought = (at: string, payload: Record<string, unknown> = {}): MarkPair => ({ bought: { value: true, at, payload } });

const wanted = () => [
  card("Sol Ring", [use("a-sol", "a"), use("b-sol", "b")]),
  card("Path to Exile", [use("a-path", "a")]),
  card("Urza's Saga", [use("b-saga", "b")]),
];

describe("a saved sourcing list and the orders placed since", () => {
  it("leaves out each copy an order placed since the list covers, the order line's deck first", () => {
    const cards = wanted();
    const got = withoutOrdered(cards, LIST, [
      order("old", "2026-10-08", [item("Sol Ring", 2)]),
      order("new", "2026-11-13", [item("Sol Ring", 1, "b"), item("Path to Exile", 2), item("Urza’s Saga"), item("Not On The List", 4)], { order_number: "56001" }),
    ]);
    expect(got.cards.map(c => [c.name, c.uses.map(u => u.id)])).toEqual([["Sol Ring", ["a-sol"]], ["Path to Exile", []], ["Urza's Saga", []]]);
    expect(got.copies).toBe(3);
    expect(got.covered).toEqual([
      { card: "Sol Ring", qty: 1, decks: ["Deck b"], by: "Pat's Games order 56001 of Nov 13, 2026" },
      // Two were ordered and the list wanted one: one copy is covered, and nothing is owed back.
      { card: "Path to Exile", qty: 1, decks: ["Deck a"], by: "Pat's Games order 56001 of Nov 13, 2026" },
      { card: "Urza's Saga", qty: 1, decks: ["Deck b"], by: "Pat's Games order 56001 of Nov 13, 2026" },
    ]);
    // The saved list itself is untouched.
    expect(cards[0]!.uses).toHaveLength(2);
  });

  it("counts only real orders that were placed, and only ones newer than the list", () => {
    const sol = [item("Sol Ring", 2)];
    const none = withoutOrdered(wanted(), LIST, [
      order("draft", "2026-11-13", sol, { status: "draft" }),
      order("cancelled", "2026-11-13", sol, { status: "cancelled" }),
      order("prints", "2026-11-13", sol, { kind: "proxy", status: "placed" }),
      order("same-day", "2026-11-12", sol),
      order("undated", null, sol),
    ]);
    expect(none.copies).toBe(0);
    expect(none.covered).toEqual([]);
    const placed = withoutOrdered(wanted(), LIST, [order("placed", "2026-11-13", sol, { status: "placed" })]);
    expect(placed.copies).toBe(2);
    // Nothing covered: the same cards come back, so nothing downstream recomputes.
    const cards = wanted();
    expect(withoutOrdered(cards, LIST, []).cards).toBe(cards);
    expect(withoutOrdered(cards, {}, [order("new", "2026-11-13", sol)]).cards).toBe(cards);
  });

  it("goes by the orders a list says it counted, when it says", () => {
    const orders = [order("counted", "2026-11-13", [item("Sol Ring")]), order("not-counted", "2026-10-01", [item("Path to Exile")])];
    const got = withoutOrdered(wanted(), { ...LIST, orders_counted: ["counted", 7] }, orders);
    expect(got.covered.map(c => c.card)).toEqual(["Path to Exile"]);
    expect(got.covered[0]!.by).toBe("Pat's Games order of Oct 1, 2026");
  });

  it("takes a bought mark made since the list as a copy bought, once", () => {
    const swaps = [swap("a|sol", "a", "Sol Ring"), swap("a|path", "a", "Path to Exile"), swap("b|saga", "b", "Urza's Saga"), swap("b|sol", "b", "Sol Ring", { order_item: { order: "x", line: 1 } })];
    const marks = new Map<string, MarkPair>([
      ["a|sol", bought("2026-11-13T12:00:00.000Z", { store_label: "Mothership", qty: 1 })],
      // Marked before the list was made: the list already knew.
      ["a|path", bought("2026-11-01T12:00:00.000Z")],
      // The plan has this swap's order: the order speaks for it.
      ["b|sol", bought("2026-11-13T12:00:00.000Z")],
      // A newer order lists this card: the same purchase, not a second copy.
      ["b|saga", bought("2026-11-13T12:00:00.000Z")],
    ]);
    const got = withoutOrdered(wanted(), LIST, [order("new", "2026-11-13", [item("Urza's Saga")])], swaps, marks);
    expect(got.covered).toEqual([
      { card: "Urza's Saga", qty: 1, decks: ["Deck b"], by: "Pat's Games order of Nov 13, 2026" },
      { card: "Sol Ring", qty: 1, decks: ["Deck a"], by: "Marked bought at Mothership on Nov 13, 2026" },
    ]);
    expect(got.cards[0]!.uses.map(u => u.id)).toEqual(["b-sol"]);
  });

  it("drops a card with no copy left from the page's rows, and lists what was left out by order", () => {
    const doc = { decks: [{ key: "a", name: "Deck a", builds: [{ id: "b3", label: "B3", bracket: 3, list: "1 Sol Ring\n1 Path to Exile" }] }, { key: "b", name: "Deck b", builds: [{ id: "b3", label: "B3", bracket: 3, list: "1 Sol Ring\n1 Urza's Saga" }] }] } as unknown as ResearchDocument;
    const got = withoutOrdered(wanted(), LIST, [order("new", "2026-11-13", [item("Path to Exile"), item("Sol Ring", 1, "a"), item("Sol Ring", 1, "b")])]);
    expect(portfolioRows(got.cards, doc, new Set(["a", "b"]), "", "all").map(c => c.name)).toEqual(["Urza's Saga"]);
    expect(coveredLines(got.covered)).toEqual([{ by: "Pat's Games order of Nov 13, 2026", cards: "Path to Exile, Sol Ring (2)" }]);
  });
});
