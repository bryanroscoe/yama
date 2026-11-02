// Your shopping rules, edited in Yama (docs/shopping-design.md, "Account-level rules"): the local
// buy rule and the sealed precon cap. Saving makes a new rule set dated the day you save it, a copy
// of the set in force with these two rules replaced, so older checks keep their own day's rules.
// The server checks the same limits (server/src/plan/rules.rs).

import { localBuyRule, type LocalBuyRule } from "./trip";
import { rulesAt, type RuleSet } from "./rules";

export interface ShoppingRulesDraft {
  local_buy: LocalBuyRule;
  /** The most to pay for a sealed precon, per deck, before tax; null: no limit. */
  sealed_max_usd: number | null;
}

/** Most tiers a rule may have. */
export const MAX_TIERS = 6;
/** The largest dollar amount a rule takes, and the largest multiple of market. */
export const MAX_RULE_USD = 10000;
export const MAX_MULTIPLE = 10;

/** What the editor starts from: the rule in force on `date`, or one built from its older fields. */
export function shoppingRulesDraft(settings: RuleSet[], date: string): ShoppingRulesDraft {
  const set = rulesAt(settings, date);
  const rule = localBuyRule(set).rule ?? { max_usd: null, always_ok_usd: null, tiers: [] };
  const sealed = set?.rules.sealed_max_usd;
  return { local_buy: { ...rule, tiers: rule.tiers.map((t) => ({ ...t })) }, sealed_max_usd: typeof sealed === "number" && Number.isFinite(sealed) ? sealed : null };
}

const money = (v: number | null) => v == null || (Number.isFinite(v) && v >= 0 && v <= MAX_RULE_USD);

/** What's wrong with a draft, in words; empty when it can be saved. */
export function shoppingRulesProblems(d: ShoppingRulesDraft): string[] {
  const out: string[] = [];
  const lb = d.local_buy;
  if (!money(lb.max_usd)) out.push(`The most a card may cost must be $0 to $${MAX_RULE_USD}.`);
  if (!money(lb.always_ok_usd)) out.push(`The always-fine price must be $0 to $${MAX_RULE_USD}.`);
  if (lb.max_usd != null && lb.always_ok_usd != null && lb.always_ok_usd > lb.max_usd) out.push("The always-fine price can't be above the most a card may cost.");
  if (lb.tiers.length > MAX_TIERS) out.push(`At most ${MAX_TIERS} market ranges.`);
  let low = 0;
  lb.tiers.forEach((t, i) => {
    if (!(Number.isFinite(t.max_multiple) && t.max_multiple > 0 && t.max_multiple <= MAX_MULTIPLE)) out.push(`Range ${i + 1}: the multiple of market must be above 0 and at most ${MAX_MULTIPLE}.`);
    const last = i === lb.tiers.length - 1;
    if (t.market_under == null && !last) out.push(`Range ${i + 1}: only the last range can be "any market".`);
    if (t.market_under != null) {
      if (!money(t.market_under) || t.market_under <= low) out.push(`Range ${i + 1}: the market limit must be above ${i ? "the one before" : "$0"}.`);
      low = Math.max(low, t.market_under);
    }
  });
  if (!money(d.sealed_max_usd)) out.push(`The sealed precon limit must be $0 to $${MAX_RULE_USD}.`);
  return out;
}
