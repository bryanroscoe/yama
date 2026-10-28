// Installed ticks and "bought it" marks by live swap, following aliases the way answers do, so a
// renamed or promoted swap keeps its marks. A mark is the owner's claim: it never makes an order,
// never changes a list and never counts a card as owned.

import { wins } from "./overlay";
import { resolveKey } from "./text";
import type { Mark, Swap } from "./types";

export type MarkPair = { installed?: Mark; bought?: Mark };

/** What a bought mark records (`payload`), typed. Missing fields are null. */
export interface BoughtInfo {
  store_key: string | null;
  store_label: string | null;
  /** For one copy; null when not known, never 0 for unknown. */
  price_paid: number | null;
  qty: number;
  on: string | null;
}

export function boughtInfo(m: Mark | undefined): BoughtInfo | null {
  if (!m?.value) return null;
  const p = m.payload ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const price = typeof p.price_paid === "number" && Number.isFinite(p.price_paid) ? p.price_paid : null;
  const qty = typeof p.qty === "number" && p.qty >= 1 ? Math.floor(p.qty) : 1;
  return { store_key: str(p.store_key), store_label: str(p.store_label), price_paid: price, qty, on: str(p.on) };
}

/**
 * Each live swap's marks (aliases followed; when two keys reach one swap, the newer mark wins), and
 * the keys whose marks reach no live swap. An orphan is listed only if one of its marks is set.
 */
export function markIndex(
  marks: Record<string, MarkPair>,
  aliases: Record<string, string>,
  liveKeys: Iterable<string>,
): { marks: Map<string, MarkPair>; orphans: [string, MarkPair][] } {
  const live = new Set(liveKeys);
  const out = new Map<string, MarkPair>();
  const orphans: [string, MarkPair][] = [];
  const stamp = (m: Mark) => ({ at: m.at, op_id: m.op_id ?? null, origin: "yama" });
  for (const [key, pair] of Object.entries(marks)) {
    const to = resolveKey(key, live, aliases);
    if (to === null) {
      if (pair.installed?.value || pair.bought?.value) orphans.push([key, pair]);
      continue;
    }
    const cur = out.get(to) ?? {};
    const next: MarkPair = { ...cur };
    for (const kind of ["installed", "bought"] as const) {
      const m = pair[kind];
      if (m && wins(stamp(m), cur[kind] && stamp(cur[kind]!))) next[kind] = m;
    }
    out.set(to, next);
  }
  return { marks: out, orphans };
}

/** Whether a planned swap is in the deck, and who says so. */
export interface InstalledState {
  /** In the deck: ticked here, or recorded as installed by the planner. */
  on: boolean;
  /** The planner records it as skipped (and no newer tick here says otherwise): not waiting to go in. */
  skipped: boolean;
  /**
   * Where `on` comes from: the deck's own current list (when the plan deck has a Yama deck), your
   * tick in Yama, the planner's own install record, or nothing yet.
   */
  from: "deck" | "yama" | "plan" | null;
  /** The planner's record ("installed" or "skipped") when it has one, even when a newer tick wins. */
  planStatus: "installed" | "skipped" | null;
}

/**
 * The deck itself decides when the plan deck has a Yama deck (Bryan, 2026-10-28: installed status
 * lives on the decks): `swap.deck_installed`, read from its current list. A swap that isn't in the
 * deck stays "skipped" if the planner skipped it. With no Yama deck, start from the planner's
 * install record (commander-decks' data/upgrades.json, carried as `swap.upgrade`), and let a Yama
 * tick win when it is newer than the swap as last imported. A status of planned or ordered says
 * nothing about the deck, so any tick wins over it.
 */
export function installedState(s: Swap, m: Mark | undefined): InstalledState {
  const st = s.upgrade?.status;
  const planStatus = st === "installed" || st === "skipped" ? st : null;
  if (s.stage === "planned" && s.deck_installed != null) {
    return { on: s.deck_installed, skipped: !s.deck_installed && (planStatus === "skipped" || !!s.deck_superseded), from: "deck", planStatus };
  }
  if (m && (!planStatus || !s.updated_at || m.at > s.updated_at)) return { on: !!m.value, skipped: false, from: "yama", planStatus };
  if (planStatus) return { on: planStatus === "installed", skipped: planStatus === "skipped", from: "plan", planStatus };
  return { on: false, skipped: false, from: null, planStatus: null };
}
