// The admin area's server data (server/src/admin). Every route answers non-admins with a 404.

import { api } from "../api";
import type { ForgeView } from "../lab/api";

export interface Limits {
  lab_games_per_day: number | null;
  lab_runs_at_a_time: number | null;
  advisor_per_day: number | null;
  watch_at_a_time: number | null;
}

export interface UsageRow {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  limited: boolean;
  disabled: boolean;
  decks: number;
  collection_cards: number;
  games_logged: number;
  games_played: number;
  has_plan: boolean;
  lab_games_today: number;
  lab_games_queued: number;
  lab_runs_unfinished: number;
  advisor_today: number;
  advisor_total: number;
  advisor_own_key: boolean;
  /** An admin granted it the shared API key (missing on older servers). */
  advisor_shared?: boolean;
  advisor_shared_limit?: number | null;
  /** Whose Claude the account would ask on: the server's subscription, its own key, the shared key, or none. */
  advisor_mode: "subscription" | "own_key" | "shared" | null;
  /** Why it can't ask, when it can't. */
  advisor_reason?: "off" | "keys_off" | "needs_key" | "power_only" | null;
  watch_running: number;
  limits: Limits;
}

export interface UsageTotals {
  accounts: number;
  open_signup_accounts: number;
  disabled: number;
  seen_today: number;
  decks: number;
  games_logged: number;
  lab_games_today: number;
  lab_games_queued: number;
  lab_queue_cap: number;
  lab_open_queue_games: number;
  lab_open_queue_cap: number;
  advisor_today: number;
  watch_running: number;
  online_games_live: number;
}

export interface Usage {
  accounts: UsageRow[];
  totals: UsageTotals;
}

export interface WatchItem {
  id: string;
  owner_id: string;
  owner_email: string | null;
  owner_name: string | null;
  created_at: string;
  seats: { name: string; deck: string | null; level: string | null }[];
  playing: boolean;
  finished: boolean;
  actions: number;
  turn: number;
  viewers: number;
  stopped: string | null;
}

export interface ServerInfo {
  version: string;
  started_at: string;
  engine: {
    label: string;
    runner: string;
    status: "ready" | "loading" | "off" | "failed";
    cards: number | null;
    why: string | null;
    card_data_file: string | null;
    live_online_games: number;
  };
  scryfall: { kind: string; started_at: string; finished_at: string | null; source_updated_at: string | null; rows: number | null; error: string | null }[];
  calendar: { sets_checked_at: string | null; precons: number; precons_fetched_at: string | null };
  database: { file: string | null; bytes: number | null; wal_bytes: number | null };
  /** The price history (missing on servers from before it). */
  prices?: {
    newest_day: string | null;
    days: number;
    backfill: PriceCheck | null;
    newest_check: PriceCheck | null;
  };
  backups: { name: string; bytes: number; modified: string | null }[];
  lab: { threads: number; unavailable: string | null; queued: number; running: number; games_waiting: number; global_runs: number };
  watch: WatchItem[];
  /** The Forge worker (missing on servers from before Forge). */
  forge?: ForgeView & { games_waiting: number };
  advisor: {
    enabled: boolean;
    reachable: boolean | null;
    subscription_connected: boolean | null;
    subscription_accounts: number;
    own_keys_enabled: boolean;
    own_keys_saved: number;
    questions_today: number;
    /** The shared API key (missing on older servers): on the advisor or not, null when unknown. */
    shared_key?: boolean | null;
    shared_accounts?: number;
    shared_spent_this_month?: number;
    shared_monthly_usd?: number;
    /** By name ("Claude Haiku 5.5"). */
    shared_models?: string[];
  };
  sign_in: { google: boolean; open_signup: boolean; password: boolean; dev_login: boolean; cloudflare_access: boolean; admin_emails: number };
}

/** Request, statement and job timings (server/src/perf.rs), in milliseconds. Routes are templates
 *  ("/api/decks/{id}"); nothing here names an account. */
export interface PerfRoute {
  method: string;
  route: string;
  /** Requests in the window (the newest 1,000 at most). */
  count: number;
  /** Requests since the server started. */
  total: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

export interface PerfSummary {
  window_minutes: number;
  slow_request_ms: number;
  slow_query_ms: number;
  /** Slowest first. */
  routes: PerfRoute[];
  /** Newest first, at most 200 each. */
  slow_requests: { at: string; method: string; route: string; status: number; ms: number }[];
  slow_statements: { at: string; ms: number; rows: number; sql: string }[];
  jobs: { at: string; job: string; ms: number; ok: boolean; slow: boolean; note: string }[];
}

/** The price history compared with the old daily table (server/src/prices/backfill.rs). */
export interface PriceCheck {
  rows: number;
  mismatches: number;
  pairs: number;
  stale: number;
  /** Days of the old table the history doesn't have (the whole check only). */
  unobserved_days?: number;
}

/** One account's grant of the shared API key (server/src/advisor/shared.rs). */
export interface SharedGrant {
  user_id: string;
  email: string;
  display_name: string;
  granted_by_name: string | null;
  granted_at: string;
  /** Its own daily cap; null for the usual allowance. */
  daily_limit: number | null;
  /** The cap in effect for its shared questions. */
  per_day: number;
  disabled: boolean;
  spent_this_month: number;
  questions_this_month: number;
  /** Whose Claude it asks on now: its own key or the subscription win over the grant; null when it can't ask. */
  mode: "subscription" | "own_key" | "shared" | null;
}

export interface SharedOverview {
  /** The advisor is set up on this server at all. */
  enabled: boolean;
  /** The advisor holds the shared key; null when it didn't answer. */
  key_on_sidecar: boolean | null;
  owner_name: string | null;
  monthly_usd: number;
  spent_this_month: number;
  month_start: string;
  next_month: string;
  /** The models shared questions may use, by name ("Claude Haiku 5.5"). */
  models: string[];
  grants: SharedGrant[];
}

export interface LabRun {
  id: string;
  name: string;
  kind: string;
  engine: string | null;
  difficulty: string | null;
  games: number;
  decks: number;
  created_at: string;
  imported_at: string;
}

export interface DeleteReport {
  email: string;
  playgroups_passed_on: number;
  playgroups_deleted: number;
  games_kept: number;
  games_deleted: number;
  seats_anonymised: number;
  online_games_removed: number;
  rows_deleted: number;
}

export const adminApi = {
  usage: () => api<Usage>("/api/admin/usage"),
  server: () => api<ServerInfo>("/api/admin/server"),
  perf: () => api<PerfSummary>("/api/admin/perf"),
  labRuns: () => api<LabRun[]>("/api/admin/lab-runs"),
  renameRun: (id: string, name: string) => api(`/api/admin/lab-runs/${encodeURIComponent(id)}`, { method: "PATCH", json: { name } }),
  deleteRun: (id: string) => api(`/api/admin/lab-runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  stopWatch: (id: string) => api(`/api/admin/watch/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  invite: (id: string) => api(`/api/admin/users/${encodeURIComponent(id)}/invite`, { method: "POST" }),
  uninvite: (id: string) => api(`/api/admin/users/${encodeURIComponent(id)}/invite`, { method: "DELETE" }),
  /** Make an account a power user (simulations, Ask Claude, no daily limit on watched games), or stop it being one. */
  setPower: (id: string, on: boolean) => api(`/api/admin/users/${encodeURIComponent(id)}/power`, { method: on ? "POST" : "DELETE" }),
  deleteAccount: (id: string, confirmEmail: string) =>
    api<DeleteReport>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", json: { confirm_email: confirmEmail } }),
  views: () => api<ViewLogRow[]>("/api/admin/views"),
  sharedOverview: () => api<SharedOverview>("/api/admin/advisor-shared"),
  /** Turn the shared key on for an account, or change its daily cap (null: the usual allowance). */
  grantShared: (id: string, dailyLimit: number | null) =>
    api<SharedOverview>(`/api/admin/users/${encodeURIComponent(id)}/advisor-shared`, { method: "PUT", json: { daily_limit: dailyLimit } }),
  revokeShared: (id: string) => api<SharedOverview>(`/api/admin/users/${encodeURIComponent(id)}/advisor-shared`, { method: "DELETE" }),
};

/** One "View as" (server/src/view_as.rs), for the viewing log. */
export interface ViewLogRow {
  id: string;
  admin_name: string;
  admin_email: string;
  target_id: string;
  target_name: string;
  target_email: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  end_reason: "stopped" | "expired" | "signed out" | "replaced" | "ended" | null;
}
