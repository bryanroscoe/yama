import { describe, expect, it } from "vitest";
import { cardGroups, cardRows, copyChip, copyKinds, priceOf, showCounts, shownText } from "./cardList";
import type { DeckEntry } from "../api";

const entry = (name: string, o: Partial<DeckEntry> & { type?: string; cmc?: number } = {}): DeckEntry =>
  ({
    name,
    oracle_id: `o-${name}`,
    board: o.board ?? "main",
    qty: o.qty ?? 1,
    owned: o.owned ?? 1,
    proxies: o.proxies ?? 0,
    needed: 0,
    cheapest_usd: o.cheapest_usd === undefined ? 1 : o.cheapest_usd,
    card: { type_line: o.type ?? "Creature — Human", cmc: o.cmc ?? 2 },
  }) as never;

const cards = [
  entry("Terra, Herald of Hope", { board: "commander", type: "Legendary Creature — Human Wizard", cmc: 3, cheapest_usd: 2 }),
  entry("Sol Ring", { type: "Artifact", cmc: 1, cheapest_usd: 1.5 }),
  entry("Demonic Tutor", { type: "Sorcery", cmc: 2, owned: 0, proxies: 1, cheapest_usd: 30 }),
  entry("Vampiric Tutor", { type: "Instant", cmc: 1, owned: 0, proxies: 0, cheapest_usd: null }),
  entry("Plains", { type: "Basic Land — Plains", cmc: 0, qty: 4, owned: 4, cheapest_usd: 0.25 }),
  entry("Sun Titan", { cmc: 6, cheapest_usd: 3 }),
  entry("Emrakul, the Aeons Torn", { type: "Legendary Creature — Eldrazi", cmc: 15, owned: 0, cheapest_usd: 20 }),
];
const rows = cardRows(cards);

describe("the Cards tab's list", () => {
  it("counts copies for each filter", () => {
    expect(showCounts(rows)).toEqual({ all: 10, need: 2, proxy: 1 });
  });

  it("groups by type in the deck's order, sorted by mana value", () => {
    const g = cardGroups(rows, "all", "type", "mv");
    expect(g.map((x) => x.title)).toEqual(["Commander", "Creatures", "Instants", "Sorceries", "Artifacts", "Lands"]);
    expect(g.find((x) => x.title === "Creatures")!.rows.map((r) => r.entry.name)).toEqual(["Sun Titan", "Emrakul, the Aeons Torn"]);
    expect(g[0]!.id).toBe("g-commander");
  });

  it("groups by mana value with lands apart, and 7 or more together", () => {
    const g = cardGroups(rows, "all", "mv", "name");
    expect(g.map((x) => x.title)).toEqual(["Commander", "Mana value 1", "Mana value 2", "Mana value 6", "7 or more", "Lands"]);
    expect(g[1]!.rows.map((r) => r.entry.name)).toEqual(["Sol Ring", "Vampiric Tutor"]);
  });

  it("sorts by price with unknown prices last, and filters to what's needed", () => {
    const all = cardGroups(rows, "all", "none", "price")[0]!;
    expect(all.rows.map((r) => r.entry.name)).toEqual(["Demonic Tutor", "Emrakul, the Aeons Torn", "Sun Titan", "Terra, Herald of Hope", "Sol Ring", "Plains", "Vampiric Tutor"]);
    const need = cardGroups(rows, "need", "none", "mv")[0]!;
    expect(need.rows.map((r) => r.entry.name)).toEqual(["Vampiric Tutor", "Emrakul, the Aeons Torn"]);
  });

  it("totals known prices only and counts the ones without", () => {
    expect(priceOf(rows, "all")).toEqual({ usd: 57.5, unpriced: 1 });
    expect(priceOf(rows, "proxy")).toEqual({ usd: 30, unpriced: 0 });
    expect(priceOf(rows.filter((r) => r.entry.cheapest_usd == null), "all")).toEqual({ usd: null, unpriced: 1 });
  });

  it("copies what's shown as a list", () => {
    expect(shownText(rows, "need")).toBe("Deck\n1 Vampiric Tutor\n1 Emrakul, the Aeons Torn");
    expect(shownText(rows, "all").startsWith("Commander\n1 Terra, Herald of Hope\n\nDeck\n1 Sol Ring")).toBe(true);
  });

  it("labels the copies the filter shows", () => {
    const split = cardRows([entry("Lightning Bolt", { qty: 3, owned: 1, proxies: 1 })])[0]!;
    expect(copyChip(split, "all")).toEqual({ tone: "need", text: "Need 1" });
    expect(copyChip(split, "proxy")).toEqual({ tone: "proxy", text: "Proxy" });
    expect(copyChip(split, "need")).toEqual({ tone: "need", text: "Need" });
    expect(copyKinds(split, "all")).toBe("1 real, 1 proxy, 1 not owned");
    expect(copyKinds(split, "proxy")).toBe("Proxy");
    const realAndProxy = cardRows([entry("Counterspell", { qty: 2, owned: 1, proxies: 1 })])[0]!;
    expect(copyChip(realAndProxy, "all")).toEqual({ tone: "proxy", text: "1 proxy" });
    expect(copyKinds(realAndProxy, "proxy")).toBe("Proxy");
  });
});
