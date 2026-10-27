// The advisor's routes (server/src/advisor). Answers stream as server-sent events over a POST, so
// `ask` reads the response body itself instead of using EventSource.

import { api, API_BASE, ApiError } from "../api";
import { parseSse, type ContextKind, type StreamEvent } from "./logic";

export interface AdvisorModel {
  id: string;
  label: string;
  note: string;
}

export interface AdvisorStatus {
  available: boolean;
  /** Whose Claude answers: the server's subscription (its owner only), your own key, or the shared key an admin granted you. */
  mode: "subscription" | "own_key" | "shared" | null;
  reason: "off" | "keys_off" | "needs_key" | null;
  has_key: boolean;
  key_hint: string | null;
  can_save_key: boolean;
  model: string;
  models: AdvisorModel[];
  per_day: number | null;
  used_today: number;
  /** Subscription accounts: whether the server holds the subscription token (null if unknown). */
  subscription_connected: boolean | null;
  /** An admin let this account ask on the shared key (used when your own key isn't there). Missing on older servers. */
  shared_granted?: boolean;
  /** Whose shared key it is ("Bryan"), when granted. */
  shared_owner?: string | null;
  /** Shared mode: the month's cap is reached until this time (UTC). */
  shared_paused_until?: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  context_kind: ContextKind;
  context_ref: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
}

export interface AdvisorMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  mode: string | null;
  status: "done" | "error" | "stopped";
  error: string | null;
  usage: { input_tokens?: number | null; output_tokens?: number | null; cost_usd?: number | null } | null;
  created_at: string;
}

export interface ConversationDetail extends Conversation {
  items: AdvisorMessage[];
}

export const advisorStatus = () => api<AdvisorStatus>("/api/advisor/status");
export const saveKey = (apiKey: string) => api<AdvisorStatus>("/api/advisor/key", { method: "PUT", json: { api_key: apiKey } });
export const removeKey = () => api<AdvisorStatus>("/api/advisor/key", { method: "DELETE" });
export const setModel = (model: string) => api<AdvisorStatus>("/api/advisor/settings", { method: "PUT", json: { model } });
export const deleteConversation = (id: string) => api<void>(`/api/advisor/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
export const deleteAllConversations = () => api<void>("/api/advisor/conversations", { method: "DELETE" });
export const conversation = (id: string) => api<ConversationDetail>(`/api/advisor/conversations/${encodeURIComponent(id)}`);

export function conversations(kind?: ContextKind, ref?: string | null) {
  const q = new URLSearchParams();
  if (kind) q.set("kind", kind);
  if (ref) q.set("ref", ref);
  const qs = q.toString();
  return api<Conversation[]>(`/api/advisor/conversations${qs ? `?${qs}` : ""}`);
}

export interface AskInput {
  conversation_id?: string | null;
  context?: { kind: ContextKind; ref?: string | null };
  question: string;
  model?: string;
}

/**
 * Ask a question and call `onEvent` for each event (`start`, `text`, then `done` or `error`).
 * Resolves when the stream ends; aborting `signal` stops the answer (the server saves what came).
 */
export async function ask(input: AskInput, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const headers = new Headers({ "Content-Type": "application/json", Accept: "text/event-stream" });
  const token = localStorage.getItem("yama.token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}/api/advisor/ask`, { method: "POST", headers, body: JSON.stringify(input), credentials: "include", signal });
  if (!res.ok || !res.body) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    for (const e of events) onEvent(e);
  }
}

export interface ProposalCard {
  oracle_id: string | null;
  name: string;
  qty: number;
  image: string | null;
  mana_cost: string | null;
  type_line: string | null;
}

export interface ProposalPreview {
  kind: "deck_edit" | "plan_swap";
  target: string;
  target_id: string | null;
  add: ProposalCard[];
  remove: ProposalCard[];
  explanation: string | null;
  checks: string | null;
}

/** A suggested change waiting for Apply or Discard (server/src/mcp/changes.rs). */
export interface StagedChange {
  id: string;
  kind: "edit_deck" | "propose_swap" | "answer_review" | "mark_bought" | "mark_installed" | "swap_in_prints" | "start_lab_run" | "more_lab_games" | "run_lab_again" | "cancel_lab_run" | "add_to_collection" | "move_cards" | "set_condition";
  summary: string;
  detail: string | null;
  /** Missing on older servers; unsupported kinds retain their readable text details. */
  preview?: ProposalPreview | null;
  /** How it was staged: Ask Claude, a key, or an app signed in with OAuth. */
  via: "question" | "key" | "oauth";
  conversation_id: string | null;
  message_id: string | null;
  status: "pending" | "applied" | "discarded";
  /** Why the last apply failed (the change stays pending). */
  error: string | null;
  /** What applying made, and the page that shows it. */
  result: { label?: string; link?: string } | null;
  created_at: string;
  decided_at: string | null;
}

export const changesKey = ["assistant", "changes"] as const;

/** Pending changes; with `conversation`, that conversation's whatever became of them; `all` for decided ones too. */
export function stagedChanges(opts: { conversation?: string; all?: boolean } = {}) {
  const q = new URLSearchParams();
  if (opts.conversation) q.set("conversation", opts.conversation);
  if (opts.all) q.set("status", "all");
  const qs = q.toString();
  return api<StagedChange[]>(`/api/assistant/changes${qs ? `?${qs}` : ""}`);
}
export const applyChange = (id: string) => api<StagedChange>(`/api/assistant/changes/${encodeURIComponent(id)}/apply`, { method: "POST" });
export const discardChange = (id: string) => api<StagedChange>(`/api/assistant/changes/${encodeURIComponent(id)}/discard`, { method: "POST" });
