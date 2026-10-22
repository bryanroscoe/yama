// The admin area's server data (server/src/admin). Every route answers non-admins with a 404.

import { api } from "../api";

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
  /** Whose Claude the account would ask on: the server's subscription, its own key, or none. */
  advisor_mode: "subscription" | "own_key" | null;
  /** Why it can't ask, when it can't. */
  advisor_reason?: "off" | "keys_off" | "needs_key" | null;
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
  backups: { name: string; bytes: number; modified: string | null }[];
  lab: { threads: number; unavailable: string | null; queued: number; running: number; games_waiting: number; global_runs: number };
  watch: WatchItem[];
  advisor: {
    enabled: boolean;
    reachable: boolean | null;
    subscription_connected: boolean | null;
    subscription_accounts: number;
    own_keys_enabled: boolean;
    own_keys_saved: number;
    questions_today: number;
  };
  sign_in: { google: boolean; open_signup: boolean; password: boolean; dev_login: boolean; cloudflare_access: boolean; admin_emails: number };
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
  labRuns: () => api<LabRun[]>("/api/admin/lab-runs"),
  renameRun: (id: string, name: string) => api(`/api/admin/lab-runs/${encodeURIComponent(id)}`, { method: "PATCH", json: { name } }),
  deleteRun: (id: string) => api(`/api/admin/lab-runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  stopWatch: (id: string) => api(`/api/admin/watch/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  invite: (id: string) => api(`/api/admin/users/${encodeURIComponent(id)}/invite`, { method: "POST" }),
  uninvite: (id: string) => api(`/api/admin/users/${encodeURIComponent(id)}/invite`, { method: "DELETE" }),
  deleteAccount: (id: string, confirmEmail: string) =>
    api<DeleteReport>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", json: { confirm_email: confirmEmail } }),
};
