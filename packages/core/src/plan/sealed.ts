// Sealed precons on your list, for the Trip page offline (docs/shopping-design.md, slice 4). The
// server works out the view (server/src/plan/sealed.rs `view`); the plan bundle keeps a copy as of
// its load. Offline, this re-judges that copy for your day and this trip: the cap from the rule set
// in force on your day, each price against it, and the pick (the cheapest in stock at a live store
// you're going to, for a product along the way only a store the card trip visits, within the cap
// when one is set). Keep it in step with `view`.

import { rulesAt, type RuleSet } from "./rules";
import type { SealedView } from "./types";

const EPS = 1e-9;

export function sealedFor(v: SealedView, settings: RuleSet[], today: string, going: string[] | null, trip: string[]): SealedView {
  const raw = rulesAt(settings, today)?.rules.sealed_max_usd;
  const cap = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  const items = v.items.map((it) => {
    const quotes = it.quotes.map((q) => ({ ...q, over_cap: q.price != null && cap != null ? q.price > cap + EPS : null }));
    const allowed = (k: string) => (it.priority === "along" ? trip.includes(k) : !going || going.includes(k));
    let best: (typeof quotes)[number] | null = null;
    for (const q of quotes) {
      if (!q.in_stock || !q.store_live || q.preference === "never" || q.price == null || !allowed(q.store)) continue;
      if (cap != null && q.over_cap !== false) continue;
      if (!best || q.price < best.price!) best = q;
    }
    return { ...it, quotes, best: best?.id ?? null };
  });
  return { ...v, date: today, cap_usd: cap, items };
}
