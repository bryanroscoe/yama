import { describe, expect, it } from "vitest";
import type { DeckEntry } from "../api";
import { buyList, cardKingdomUrl } from "./buyList";

const entry = (name: string, over: Partial<DeckEntry> = {}): DeckEntry =>
  ({ oracle_id: name, name, qty: 1, board: "main", owned: 0, proxies: 0, needed: 1, cheapest_usd: null, cheapest_printing: null, card: null, ...over }) as DeckEntry;
const priced = (usd: number, date: string) => ({ cheapest_usd: usd, cheapest_printing: { scryfall_id: "p", set_code: "cmm", set_name: "Commander Masters", collector_number: "1", date } });

const CARDS = [
  entry("Omo, Queen of Vesuva", { board: "commander", owned: 1, ...priced(1.5, "2026-11-10") }),
  entry("Sol Ring", { ...priced(1.25, "2026-11-10") }),
  entry("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", { ...priced(12, "2026-11-08") }),
  entry("Mystery Card"),
  entry("Arcane Signet", { proxies: 1, ...priced(0.5, "2026-11-10") }),
  entry("Forest", { qty: 8, owned: 2, ...priced(0.1, "2026-11-10") }),
  entry("Negate", { board: "side", ...priced(0.3, "2026-11-10") }),
];

describe("buyList", () => {
  it("lists the copies neither real cards nor proxies cover, without basics or the sideboard", () => {
    const need = buyList(CARDS, "need");
    expect(need.paste).toBe("1 Sol Ring\n1 Fable of the Mirror-Breaker\n1 Mystery Card");
    expect(need.copies).toBe(3);
  });

  it("totals known market prices only, counts the cards without one, and dates them", () => {
    const need = buyList(CARDS, "need");
    expect(need.usd).toBe(13.25);
    expect(need.unpriced).toBe(1);
    expect(need.oldest).toBe("2026-11-08");
    expect(need.newest).toBe("2026-11-10");
  });

  it("has no total, not $0, when no card has a price", () => {
    const none = buyList([entry("Mystery Card"), entry("Other Mystery", { qty: 2 })], "need");
    expect(none.usd).toBeNull();
    expect(none.unpriced).toBe(3);
    expect(none.newest).toBeNull();
  });

  it("lists the commander and main deck whole, basics included, for the whole list", () => {
    const all = buyList(CARDS, "all");
    expect(all.paste.split("\n")).toEqual(["1 Omo, Queen of Vesuva", "1 Sol Ring", "1 Fable of the Mirror-Breaker", "1 Mystery Card", "1 Arcane Signet", "8 Forest"]);
    expect(all.copies).toBe(13);
    expect(all.usd).toBe(16.05);
    expect(all.unpriced).toBe(1);
  });

  it("is empty when every card is covered", () => {
    const need = buyList([entry("Sol Ring", { owned: 1 }), entry("Forest", { qty: 4 })], "need");
    expect(need).toMatchObject({ copies: 0, usd: null, paste: "", tcgplayer: null, cardKingdom: null });
  });
});

describe("the store links", () => {
  it("open TCGplayer Mass Entry and Card Kingdom's builder with the names, by front face", () => {
    const need = buyList(CARDS, "need");
    expect(need.tcgplayer).toBe("https://www.tcgplayer.com/massentry?productline=Magic&c=1%20Sol%20Ring||1%20Fable%20of%20the%20Mirror-Breaker||1%20Mystery%20Card");
    expect(need.cardKingdom).toBe("https://www.cardkingdom.com/builder?c=1%20Sol%20Ring%0A1%20Fable%20of%20the%20Mirror-Breaker%0A1%20Mystery%20Card");
  });

  it("carry no affiliate, partner or tracking parameters", () => {
    const all = buyList(CARDS, "all");
    for (const link of [all.tcgplayer!, all.cardKingdom!]) {
      const url = new URL(link);
      expect(url.protocol).toBe("https:");
      expect([...url.searchParams.keys()].filter((k) => !["c", "productline"].includes(k))).toEqual([]);
      expect(link).not.toMatch(/partner|affiliate|utm_|ref=/i);
    }
  });

  it("escape names with commas, quotes and ampersands", () => {
    const url = cardKingdomUrl(["Minsc & Boo, Timeless Heroes", "Urza's Saga"])!;
    expect(new URL(url).searchParams.get("c")).toBe("1 Minsc & Boo, Timeless Heroes\n1 Urza's Saga");
  });

  it("give no link, only the list to paste, when it would be too long", () => {
    const many = Array.from({ length: 400 }, (_, i) => entry(`A Card With A Rather Long Name Number ${i}`));
    const all = buyList(many, "all");
    expect(all.tcgplayer).toBeNull();
    expect(all.cardKingdom).toBeNull();
    expect(all.paste.split("\n")).toHaveLength(400);
    expect(cardKingdomUrl([])).toBeNull();
  });
});
