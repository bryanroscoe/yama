// The planner's server calls. Types live in @yama/core/plan, next to the logic that reads them.
import type { ImportReport, LocalBuyRule, PlanBundle, StateName, StorePreference } from "@yama/core/plan";
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

export const setStorePreference = (store: string, body: StorePrefBody) =>
  api<{ store: string; preference: StorePreference | null }>(`/api/plan/stores/${encodeURIComponent(store)}/preference`, { method: "PUT", json: body });

/** Save your buy rule and sealed cap as a new rule set from `effective_from` (today). */
export const saveShoppingRules = (body: { effective_from: string; local_buy: LocalBuyRule; sealed_max_usd: number | null; note: string | null }) =>
  api<{ effective_from: string; origin: string }>("/api/plan/settings", { method: "POST", json: body });

/** Remove a rule set made in Yama (imported sets belong to their export). */
export const removeShoppingRules = (date: string) => api<{ removed: string }>(`/api/plan/settings/${encodeURIComponent(date)}`, { method: "DELETE" });
