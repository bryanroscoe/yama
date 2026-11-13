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
const NOT_WANTED = /\b(damaged|heavily played|signed|altered|oversized|proxy|art card|art series|japanese|german|french|italian|spanish|portuguese|korean|chinese|russian)\b/i;
/** Condition, language and kind of copy pass, from the listing's own words; `foilOk` leaves the finish out of it. */
export function knownRestrictionsPass(o: Pick<SourceOffer, "title" | "condition" | "finish" | "language">, card: string, foilOk = false): boolean {
  const title = (o.title ?? "").toLowerCase(), name = card.split(" // ")[0]!.toLowerCase();
  const at = title.indexOf(name);
  const descriptors = at < 0 ? title : title.slice(0,at) + title.slice(at+name.length);
  const words = `${o.condition} ${o.finish ?? ""} ${descriptors}`;
  return /^(nm|near\s?mint|lp|lightly\s?played|mp|moderately\s?played)(?:$|[\s/])/i.test(o.condition)
    && !NOT_WANTED.test(words) && (foilOk || !/\b(foil|etched)\b/i.test(words))
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

/** A foil costs "about the same" as a plain copy: at most $0.25 or 10% more, whichever is larger. */
export const FOIL_SAME_PRICE = { usd: 0.25, share: 0.1 };
export const foilNearPlain = (foil: number, plain: number) => foil <= Math.max(plain + FOIL_SAME_PRICE.usd, plain * (1 + FOIL_SAME_PRICE.share)) + 1e-9;

/**
 * Re-evaluate dated quotes for today's preview; never mutate the saved research. A foil copy of a
 * card that has a plain version shops only when foil is preferred, passes the same rule, and costs
 * about the same as the cheapest plain copy that qualifies.
 */
export function pricedRows(rows: SourceCard[], rule: LocalBuyRule, valid = true, preferFoil = false): SourceCard[] {
  return rows.map(c => {
    const offers = c.offers.map(o => ({ ...o, qualifies: valid && o.price != null && mayReprice(o,c.name) && judge(rule, o.price, o.market ?? null) === "ok", eligibility_unknown: !o.qualifies && o.non_price_eligible == null && !o.rule_reason && !mayReprice(o,c.name) }));
    const plain = Math.min(...offers.filter(o => o.qualifies && !o.foil_alternative && o.qty !== 0).map(o => o.price!));
    return { ...c, offers: offers.map(o => {
      if (!o.foil_alternative || !o.qualifies) return o.foil_alternative ? { ...o, qualifies: false } : o;
      // It passes the rule; the only remaining question is the price against a plain copy.
      const foil_block = !Number.isFinite(plain) ? "no_plain" as const : !foilNearPlain(o.price!, plain) ? "price" as const : undefined;
      return { ...o, qualifies: preferFoil && !foil_block, ...(foil_block ? { foil_block } : {}) };
    }) };
  });
}
