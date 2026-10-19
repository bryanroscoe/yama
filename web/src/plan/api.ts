// The planner's server calls. Types live in @yama/core/plan, next to the logic that reads them.
import type { ImportReport, PlanBundle, StateName } from "@yama/core/plan";
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
export const createKey = (name: string) => api<ScriptKey & { token: string }>("/api/me/tokens", { method: "POST", json: { name } });

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
