import { judge, MAX_RULE_USD, shoppingRulesDraft, type LocalBuyRule, type RuleSet } from "@yama/core/plan";
import type { SourceCard, SourceOffer } from "./sourcing-model";

export function readCap(text: string): { value: number | null; valid: boolean } {
  if (!text.trim()) return { value: null, valid: true };
  const value = Number(text);
  return { value, valid: Number.isFinite(value) && value >= 0 && value <= MAX_RULE_USD };
}

/** Keep the account's market and sealed rules, changing only the per-card ceiling. */
export function capDraft(settings: RuleSet[], today: string, cap: number | null) {
  const draft = shoppingRulesDraft(settings, today);
  draft.local_buy.max_usd = cap;
  // Above the ceiling this allowance has no effect; the settings API requires it within the cap.
  if (cap != null && draft.local_buy.always_ok_usd != null) draft.local_buy.always_ok_usd = Math.min(cap, draft.local_buy.always_ok_usd);
  return draft;
}

const priceOnlyReason = /^(over \$[\d.]+ ceiling|matched-printing market unknown|within market multiple|over market multiple|50 cents or less; market exception)$/;
function mayReprice(o: SourceOffer): boolean {
  if (o.qualifies) return true;
  // A larger budget must not undo a rejection for an unknown reason or a non-price restriction.
  return priceOnlyReason.test(o.rule_reason ?? "")
    && /^(nm|near\s?mint|lp|lightly\s?played|mp|moderately\s?played)(?:$|[\s/])/i.test(o.condition)
    && !/\b(foil|etched|damaged|heavily played|signed|altered)\b/i.test(`${o.condition} ${o.finish ?? ""}`)
    && (!o.language || /^(en|english)$/i.test(o.language));
}

/** Re-evaluate dated quotes for today's preview; never mutate the saved research. */
export function pricedRows(rows: SourceCard[], rule: LocalBuyRule, valid = true): SourceCard[] {
  return rows.map(c => ({ ...c, offers: c.offers.map(o => ({ ...o, qualifies: valid && o.price != null && mayReprice(o) && judge(rule, o.price, o.market ?? null) === "ok" })) }));
}
