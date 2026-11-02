// The planner's server calls. Types live in @yama/core/plan, next to the logic that reads them.
import type { ImportReport, LocalBuyRule, PlanBundle, ShoppingWant, StateName, StorePreference, StoreSnapshot } from "@yama/core/plan";
import { api } from "../api";

export type BundleReply = PlanBundle | { unchanged: true; rev: string };

/**
 * The whole bundle, or `{unchanged}` when `rev` (the cached copy's key) is still current. `signal`
 * is React Query's: cancelling or removing the query (sign-out does) aborts the request.
 */
export function fetchBundle(rev?: string, signal?: AbortSignal): Promise<BundleReply> {
  return api<BundleReply>(`/api/plan/bundle${rev ? `?rev=${encodeURIComponent(rev)}` : ""}`, { signal });
}

/**
 * Send a plan file exactly as picked. It must not be parsed and re-serialized: the server hashes
 * the bytes of its "plan" value, and Python and JavaScript write numbers differently (124.0 vs 124).
 */
export function uploadPlan(file: File, dryRun: boolean): Promise<ImportReport> {
  return api<ImportReport>(`/api/plan/import${dryRun ? "?dry_run=1" : ""}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": "application/json" },
  });
}

export function linkDeck(key: string, deckId: string | null): Promise<{ key: string; deck_id: string | null }> {
  return api(`/api/plan/decks/${encodeURIComponent(key)}`, { method: "PATCH", json: { deck_id: deckId } });
}

export function makeYamaDeck(key: string, state: StateName): Promise<{ id: string; name: string; existing: boolean; note: string }> {
  return api(`/api/plan/decks/${encodeURIComponent(key)}/yama-deck`, { method: "POST", json: { state } });
}

// ── script keys (Settings) ─────────────────────────────────────────────────

export interface ScriptKey {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export const listKeys = () => api<ScriptKey[]>("/api/me/tokens");

/** The reply is the only time the key itself is shown; Yama keeps only its hash. */
export const createKey = (name: string, scope: KeyScope = "plan:sync") => api<ScriptKey & { token: string }>("/api/me/tokens", { method: "POST", json: { name, scope } });

/** `plan:sync`: publish.py and pull.py. `mcp`: Claude's tools from outside Yama (`POST /mcp`). */
export type KeyScope = "plan:sync" | "mcp";

export const revokeKey = (id: string) => api<ScriptKey>(`/api/me/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });

export interface ImportRecord {
  id: string;
  content_hash: string;
  via: string;
  forced: boolean;
  imported_at: string;
  meta: { guide_version?: number | null; git_sha?: string | null; dirty?: boolean | null; app?: string | null };
  report: { warnings?: string[]; counts?: { swaps?: { added: number; changed: number; retired: number } } };
}

export const listImports = () => api<ImportRecord[]>("/api/plan/imports");

// ── store preferences (Trip) ───────────────────────────────────────────────

/** Your whole setting for one of your stores. Fine to go with nothing else set clears it. */
export interface StorePrefBody {
  preference: StorePreference;
  note: string | null;
  /** Your order of how easy it is to get to, from 1. */
  hassle: number | null;
  /** How much more a card may cost here and still come from it, USD. */
  premium_usd: number | null;
}

/** Your whole order of stores, easiest first, saved at once. */
export const setStoreOrder = (keys: string[]) => api<{ keys: string[] }>("/api/plan/store-order", { method: "PUT", json: { keys } });

export const setStorePreference = (store: string, body: StorePrefBody) =>
  api<{ store: string; preference: StorePreference | null }>(`/api/plan/stores/${encodeURIComponent(store)}/preference`, { method: "PUT", json: body });

/** Read your stores' stock now, in the background: one snapshot per store (docs/shopping-design.md). */
export const checkStores = (body: { stores: string[] | null; cards?: string[] | null; yestcg: boolean }) =>
  api<{ snapshots: { id: string; store: string; source: string }[]; skipped: { store: string; name: string; why: string }[]; cards: number }>("/api/plan/stock/check", {
    method: "POST",
    json: body,
  });

/** Your newest store snapshots, to follow a check. */
export const storeSnapshots = () => api<{ snapshots: StoreSnapshot[] }>("/api/plan/stock");

/** Add a card or sealed product to your shopping list. */
export const addWant = (body: { kind: "card" | "sealed"; name: string; qty: number; priority: "need" | "along"; deck_id: string | null; deck_name: string | null; why: string | null }) =>
  api<ShoppingWant>("/api/plan/wants", { method: "POST", json: body });

/** Take a want off your list. */
export const removeWant = (id: string) => api<{ removed: string }>(`/api/plan/wants/${encodeURIComponent(id)}`, { method: "DELETE" });

/** A deck's cards your collection doesn't hold enough real copies of (basic lands left out). */
export const deckGaps = (deck: string) =>
  api<{ deck: string; name: string; cards: { name: string; need: number; real: number; proxy: number }[] }>(`/api/plan/wants/deck-gaps/${encodeURIComponent(deck)}`);

export interface SealedQuote {
  id: string;
  store: string;
  store_name: string;
  preference: StorePreference;
  /** False when a later import retired the store: it's never the best choice. */
  store_live: boolean;
  price: number | null;
  in_stock: boolean;
  checked_on: string;
  note: string | null;
  /** Null when there's no price or no cap. */
  over_cap: boolean | null;
  vs_market_pct: number | null;
  vs_singles_pct: number | null;
}

export interface SealedItem {
  want: string;
  name: string;
  qty: number;
  priority: "need" | "along";
  why: string | null;
  precon: { id: string; name: string; set_name: string | null; released: string | null } | null;
  market: { usd: number | null; price_date: string; source: string; url: string; product_name: string } | null;
  singles: { usd: number | null; priced_copies: number; unpriced_copies: number; oldest_date: string | null; newest_date: string | null; source: string } | null;
  /** Each store's newest price, cheapest first. */
  quotes: SealedQuote[];
  /** The cheapest in stock at a store you'll go to, within the cap when one is set. */
  best: string | null;
}

/** The sealed products on your list with store prices, the sealed market and the singles inside. */
export const sealedView = (today: string) =>
  api<{ date: string; cap_usd: number | null; items: SealedItem[] }>(`/api/plan/sealed?today=${encodeURIComponent(today)}`);

/** A store's dated price for a sealed product on your list. */
export const addSealedQuote = (want: string, body: { store: string; price: number | null; in_stock: boolean; checked_on: string; note: string | null }) =>
  api<{ id: string }>(`/api/plan/sealed/${encodeURIComponent(want)}/quotes`, { method: "POST", json: body });

export const removeSealedQuote = (id: string) => api<{ removed: string }>(`/api/plan/sealed/quotes/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Save your buy rule and sealed cap as a new rule set from `effective_from` (today). */
export const saveShoppingRules = (body: { effective_from: string; local_buy: LocalBuyRule; sealed_max_usd: number | null; note: string | null }) =>
  api<{ effective_from: string; origin: string }>("/api/plan/settings", { method: "POST", json: body });

/** Remove a rule set made in Yama (imported sets belong to their export). */
export const removeShoppingRules = (date: string) => api<{ removed: string }>(`/api/plan/settings/${encodeURIComponent(date)}`, { method: "DELETE" });
