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
