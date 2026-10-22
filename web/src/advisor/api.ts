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
  mode: "subscription" | "own_key" | null;
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
