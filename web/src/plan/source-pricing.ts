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
function knownRestrictionsPass(o: SourceOffer, card: string): boolean {
  const title = (o.title ?? "").toLowerCase(), name = card.split(" // ")[0]!.toLowerCase();
  const at = title.indexOf(name);
  const descriptors = at < 0 ? title : title.slice(0,at) + title.slice(at+name.length);
  return /^(nm|near\s?mint|lp|lightly\s?played|mp|moderately\s?played)(?:$|[\s/])/i.test(o.condition)
    && !/\b(foil|etched|damaged|heavily played|signed|altered|oversized|proxy|art card|art series|japanese|german|french|italian|spanish|portuguese|korean|chinese|russian)\b/i.test(`${o.condition} ${o.finish ?? ""} ${descriptors}`)
    && (!o.language || /^(en|english)$/i.test(o.language));
}
function mayReprice(o: SourceOffer, card: string): boolean {
  if (o.non_price_eligible === false) return false;
  if (o.non_price_eligible === true) return true;
  if (o.qualifies) return true;
  if (!knownRestrictionsPass(o,card)) return false;
  if (priceOnlyReason.test(o.rule_reason ?? "")) return true;
  // Older reports did not record a rejection reason. Reconstruct eligibility only when
  // their saved non-price facts are complete, rather than assuming missing facts passed.
  return !o.rule_reason && o.finish === "nonfoil" && /^(en|english)$/i.test(o.language ?? "");
}

/** Re-evaluate dated quotes for today's preview; never mutate the saved research. */
export function pricedRows(rows: SourceCard[], rule: LocalBuyRule, valid = true): SourceCard[] {
  return rows.map(c => ({ ...c, offers: c.offers.map(o => ({ ...o, qualifies: valid && o.price != null && mayReprice(o,c.name) && judge(rule, o.price, o.market ?? null) === "ok", eligibility_unknown: !o.qualifies && o.non_price_eligible == null && !o.rule_reason && !mayReprice(o,c.name) })) }));
}
