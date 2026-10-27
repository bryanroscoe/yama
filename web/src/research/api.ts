import { api } from "../api";

export interface Source { title: string; url: string; accessed?: string }
export interface Power { range?: string; label?: string; confidence?: string; rationale?: string; speed?: string; vulnerabilities?: string[] }
export interface Item {
  card?: string; deck?: string; qty?: number; kind?: string; detail?: string; reason?: string;
  store?: string; price?: number | null; market?: number | null; printing?: string; condition?: string;
  checked?: string; url?: string; transfer?: boolean; quote?: Item;
  local_check?: string;
}
export interface Swap { id: string; card_in: string; card_out?: string; why?: string; why_out?: string; acquisition?: Item; pairing_note?: string }
export interface Combo {
  id: string; name: string; kind?: string; cards?: string[]; setup?: string[]; steps?: string[];
  outcome?: string; stop_points?: string[]; bracket_fit?: string; sources?: Source[];
  present?: boolean; missing_cards?: string[];
  is_caution?: boolean;
}
export interface Build {
  id: string; label: string; bracket?: number | null; prospective?: boolean; power?: Power; why?: string;
  risks?: string[]; game_changers?: string[]; stats?: Record<string, unknown>; list: string;
  swaps?: Swap[]; acquisition?: { scenario?: string; note?: string; owned?: Item[]; buys?: Item[]; prints?: Item[]; basics?: Item[] };
  combos?: Combo[];
  base_build?: string; option_swap?: { card_in?: string; card_out?: string; inn?: string; out?: string };
}
export interface ResearchDeck {
  key: string; name: string; commander: string; ownership?: string; installed_state?: string; summary?: string;
  recommended_build?: string; pilot?: string; sources?: Source[]; builds: Build[];
  guide_comparison?: string; mechanics?: string[]; warnings?: string[]; combo_limits?: string[];
  existing_swap_audit?: { inn?: string; out?: string; verdict?: string; reason?: string }[];
}
export interface Scenario {
  id: string; label: string; deck_count?: number; note?: string; buys?: Item[]; prints?: Item[];
  buy_total?: number | null; print_count?: number;
}
export interface ResearchDocument {
  schema: "yama-research/1"; id: string; title: string; generated_at: string; summary?: string;
  method?: string[]; scenarios?: Scenario[]; decks: ResearchDeck[];
  power_scale?: { range: string; meaning: string }[];
  power_method?: string[];
  local_checks?: Record<string, { reason?: string; coverage?: string; checked?: string; local_checks?: { store: string; checked?: string; errors?: string[]; search_may_be_truncated?: boolean }[]; rejected_offers?: Item[]; market_reference?: { market?: number | null; set?: string; num?: string; url?: string } }>;
}
export interface Review { target: string; decision: string | null; note: string | null; target_hash: string; version: number; updated_at: string }
export interface ResearchBundle { document: ResearchDocument; revision: number; updated_at: string; target_hashes: Record<string, string>; reviews: Review[] }
export interface ReportSummary { id: string; title: string; revision: number; updated_at: string }
export interface ReviewOp { op_id: string; target: string; decision: string | null; note: string | null; expected_version: number; target_hash: string }

export const reports = () => api<ReportSummary[]>("/api/research");
export const report = (id: string) => api<ResearchBundle>(`/api/research/${encodeURIComponent(id)}`);
export const saveReview = (id: string, op: ReviewOp) => api<Review>(`/api/research/${encodeURIComponent(id)}/reviews`, { method: "POST", json: op });
export const importReport = (document: unknown) => api<{ id: string; changed: boolean; revision: number }>("/api/research", { method: "POST", json: document });

export function safeUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try { const url = new URL(raw); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function money(value?: number | null): string {
  return value == null || !Number.isFinite(value) ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}
export function targetForSwap(deck: string, build: string, swap: string): string { return `swap:${deck}:${build}:${swap}`; }
export function changedAnswer(bundle: ResearchBundle, answer: Review): boolean { return bundle.target_hashes[answer.target] !== answer.target_hash; }
