// Store stock checks: only each store's newest check counts, so a newer "sold out" replaces an
// older "in stock" at the same store.

import type { Quote } from "./types";

/** Each store's newest stock checks among these quotes (every check of that store's newest date). */
export function newestChecks(quotes: Quote[]): Quote[] {
  const byStore = new Map<string, Quote[]>();
  for (const q of quotes) {
    if (q.kind !== "stock_check") continue;
    const k = q.store ?? `label:${q.store_label ?? ""}`;
    byStore.set(k, [...(byStore.get(k) ?? []), q]);
  }
  const out: Quote[] = [];
  for (const list of byStore.values()) {
    const newest = list.reduce((d, q) => (q.checked > d ? q.checked : d), "");
    out.push(...list.filter((q) => q.checked === newest));
  }
  return out;
}
