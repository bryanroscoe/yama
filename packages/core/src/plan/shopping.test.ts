import { describe, expect, test } from "vitest";
import { MASS_ENTRY_MAX, massEntryUrl, pasteText, proSearchUrl } from "./carts";
import { shoppingRulesDraft, shoppingRulesProblems, type ShoppingRulesDraft } from "./shoprules";
import type { RuleSet } from "./rules";

const set = (effective_from: string, rules: RuleSet["rules"], origin = "import"): RuleSet => ({ effective_from, rules, note: null, origin });
const BRYAN = { max_usd: 2, always_ok_usd: 0.5, tiers: [{ market_under: 1, max_multiple: 2 }, { market_under: null, max_multiple: 1.5 }] };

describe("lists to paste and links", () => {
  test("one card a line, a repeat counted once", () => {
    expect(pasteText(["Sol Ring", "Fellwar Stone", "Sol Ring"])).toBe("2 Sol Ring\n1 Fellwar Stone");
    expect(pasteText([])).toBe("");
  });

  test("TCGplayer Mass Entry: each line encoded, joined by ||, front faces, too long is null", () => {
    expect(massEntryUrl(["Sol Ring", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "+2 Mace"])).toBe(
      "https://www.tcgplayer.com/massentry?productline=Magic&c=1%20Sol%20Ring||1%20Fable%20of%20the%20Mirror-Breaker||1%20%2B2%20Mace",
    );
    expect(massEntryUrl([])).toBeNull();
    const many = Array.from({ length: 400 }, (_, i) => `A Long Card Name Number ${i}`);
    expect(massEntryUrl(many)).toBeNull();
    expect(massEntryUrl(many.slice(0, 20))!.length).toBeLessThanOrEqual(MASS_ENTRY_MAX);
  });

  test("a TCGplayer Pro storefront gets a search link; any other homepage doesn't", () => {
    expect(proSearchUrl({ homepage: "https://blackcastlegamez.tcgplayerpro.com" }, "Sol Ring")).toBe(
      "https://blackcastlegamez.tcgplayerpro.com/search/products?q=Sol%20Ring&productLineName=Magic%3A%20The%20Gathering&sort=price-asc",
    );
    expect(proSearchUrl({ homepage: "https://patsgames.com" }, "Sol Ring")).toBeNull();
    expect(proSearchUrl({ homepage: "http://x.tcgplayerpro.com" }, "Sol Ring")).toBeNull();
    expect(proSearchUrl({ homepage: "https://evil.com/.tcgplayerpro.com" }, "Sol Ring")).toBeNull();
    expect(proSearchUrl({ homepage: "https://evil.example?next=.tcgplayerpro.com" }, "Sol Ring")).toBeNull();
    expect(proSearchUrl({ homepage: "https://evil.example#.tcgplayerpro.com" }, "Sol Ring")).toBeNull();
    expect(proSearchUrl({ homepage: null }, "Sol Ring")).toBeNull();
  });
});

describe("your shopping rules", () => {
  test("the editor starts from the rule in force, or one read from older fields", () => {
    const sets = [set("2026-10-10", { ceiling_other_usd: 3, max_over_market_pct: 25 }), set("2026-10-28", { local_buy: BRYAN, sealed_max_usd: 51 })];
    expect(shoppingRulesDraft(sets, "2026-11-01")).toEqual({ local_buy: BRYAN, sealed_max_usd: 51 });
    expect(shoppingRulesDraft(sets, "2026-10-20")).toEqual({ local_buy: { max_usd: 3, always_ok_usd: null, tiers: [{ market_under: null, max_multiple: 1.25 }] }, sealed_max_usd: null });
    expect(shoppingRulesDraft([], "2026-11-01")).toEqual({ local_buy: { max_usd: null, always_ok_usd: null, tiers: [] }, sealed_max_usd: null });
  });

  test("checks the limits the server checks", () => {
    const ok: ShoppingRulesDraft = { local_buy: BRYAN, sealed_max_usd: 51 };
    expect(shoppingRulesProblems(ok)).toEqual([]);
    const bad = (lb: Partial<ShoppingRulesDraft["local_buy"]>, sealed: number | null = null) => shoppingRulesProblems({ local_buy: { ...BRYAN, ...lb }, sealed_max_usd: sealed });
    expect(bad({ always_ok_usd: 3 })).toEqual(["The always-fine price can't be above the most a card may cost."]);
    expect(bad({ max_usd: -1 })[0]).toContain("most a card may cost");
    expect(bad({ tiers: [{ market_under: null, max_multiple: 2 }, { market_under: 1, max_multiple: 1.5 }] })).toEqual(['Range 1: only the last range can be "any market".']);
    expect(bad({ tiers: [{ market_under: 2, max_multiple: 2 }, { market_under: 1, max_multiple: 1.5 }] })).toEqual(["Range 2: the market limit must be above the one before."]);
    expect(bad({ tiers: [{ market_under: 1, max_multiple: 0 }] })).toEqual(["Range 1: the multiple of market must be above 0 and at most 10."]);
    expect(bad({}, -5)).toEqual(["The sealed precon limit must be $0 to $10000."]);
  });
});
