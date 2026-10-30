import { api } from "../api";

export const KINDS = {
  performance: "Performance observations", commander: "Commander catalog", weekly_activity: "Weekly activity",
  commander_history: "Commander histories", archetype: "Strategy references", source_table: "Source tables",
} as const;
export type Kind = keyof typeof KINDS;
export interface Dataset {
  id: string; title: string; revision: number; content_hash: string; imported_at: string;
  records: Partial<Record<Kind, number>>; source_documents: number;
  source: { name: string; url: string; attribution?: string; license?: string };
  generated_at?: string; method?: string; coverage?: unknown;
}
export interface EvidenceRecord { id: string; entity: string; kind: Kind; sources: string[]; data: Record<string, unknown> }
export interface Source {
  sha256: string; url?: string; retrieved_at?: string; source_as_of?: string; captured_at?: string;
  flags?: string[]; transformation?: string;
}
export interface MonthlySummary {
  cohort: string; months: number; excluded_months: number; source_reported_games: number;
  weighted_source_rate_percent: number | null; half_life_days: number; as_of: string;
}
export interface DatasetRead {
  dataset: Dataset; records?: EvidenceRecord[]; sources?: Source[]; next_offset: number | null;
  monthly_summaries?: MonthlySummary[]; summary_note?: string | null;
}

export const datasets = () => api<Dataset[]>("/api/datasets");
export function datasetPath(id: string, params: URLSearchParams): string {
  // UI-only labels never become API parameters. Keep every read bounded and pin its revision.
  const query = new URLSearchParams({ limit: "25" });
  for (const key of ["revision", "section", "kind", "entity", "search", "offset", "half_life_days", "as_of"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  return `/api/datasets/${encodeURIComponent(id)}?${query}`;
}
export const dataset = (id: string, params: URLSearchParams) => api<DatasetRead>(datasetPath(id, params));
export const recordName = (r: EvidenceRecord) => text(r.data.entity_name) || text(r.data.name) || r.entity;
export const text = (v: unknown): string => typeof v === "string" ? v : "";
export const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const count = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "Unknown";
export const percent = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(2)}%` : "Unknown";
export function sourceUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return;
  try { const u = new URL(v); if (["https:", "http:"].includes(u.protocol) && !u.username && !u.password) return u.href; } catch { /* Plain text when no safe link exists. */ }
}
export function periodLabel(value: unknown): string {
  const p = object(value);
  if (p.kind === "calendar_month") return `Complete month ${text(p.start)} to ${text(p.end)}`;
  if (p.kind === "rolling_window") return `${count(p.lookback_days)}-day window as of ${text(p.source_as_of).slice(0, 10)}`;
  if (p.kind === "cumulative_snapshot") return `Cumulative snapshot${p.source_as_of ? ` as of ${text(p.source_as_of).slice(0, 10)}` : ""}`;
  return "Period unknown";
}

/** What the shared precon pages take from datasets (admin only, server/src/precon_evidence). */
export interface PreconEvidenceReport {
  sources: { owner: string; source_name: string; enabled_at: string }[];
  source_labels: { name: string; datasets: { id: string; revision: number; imported_at: string }[] }[];
  entities: number; catalog_precons: number; catalog_without_real_games: number;
  matched: Record<string, [string, string, string][]>;
  unmatched: { source: string; entity: string; name: string; url: string | null; reason: string }[];
}
export const preconEvidence = () => api<PreconEvidenceReport>("/api/admin/precon-evidence");
export const setPreconEvidence = (source: string, on: boolean) =>
  api<PreconEvidenceReport>(`/api/admin/precon-evidence/sources/${encodeURIComponent(source)}`, { method: on ? "PUT" : "DELETE" });
