// "Ask Claude" without React: reading the server's event stream, and turning an answer's light
// markdown into blocks the panel renders as elements (never as HTML), with each ```suggestion
// block parsed so the panel can offer to save it as an idea.

import type { AdvisorStatus } from "./api";

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Split complete server-sent events off the front of `buffer`; the rest waits for more bytes. */
export function parseSse(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const frames = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try {
      events.push({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
    } catch {
      /* a frame that isn't JSON is skipped */
    }
  }
  return { events, rest };
}

export interface Suggestion {
  in: string;
  out: string | null;
  why: string | null;
}

export type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "suggestion"; suggestion: Suggestion; raw: string };

/** The fields of a ```suggestion block, or null when it has no card to put in. */
export function parseSuggestion(body: string): Suggestion | null {
  const field = (name: string) => {
    const m = body.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "im"));
    const v = m?.[1]?.trim() ?? "";
    return v && !/^(none|n\/a|-|blank)$/i.test(v) ? v : null;
  };
  const inn = field("in");
  if (!inn) return null;
  return { in: inn.slice(0, 200), out: field("out")?.slice(0, 200) ?? null, why: field("why")?.slice(0, 2000) ?? null };
}

/** Blocks of an answer, as far as it has arrived (an unclosed code fence is shown as code). */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1]?.toLowerCase() ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      const raw = body.join("\n");
      const s = lang === "suggestion" ? parseSuggestion(raw) : null;
      blocks.push(s ? { kind: "suggestion", suggestion: s, raw } : { kind: "code", text: raw });
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1]!.trim() });
    } else if (bullet || numbered) {
      const ordered = !!numbered;
      if (para.length) {
        blocks.push({ kind: "p", text: para.join(" ") });
        para = [];
      }
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!.trim());
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export type Segment = { text: string; bold?: boolean; code?: boolean };

/** **bold** and `code` inside a line; everything else is plain text. */
export function inline(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] != null) out.push({ text: m[1], bold: true });
    else out.push({ text: m[2]!, code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export type ContextKind = "general" | "plan_deck" | "review" | "deck" | "precon" | "experiment";

/** Starter questions for each context, shown in an empty panel. */
export function starters(kind: ContextKind): string[] {
  switch (kind) {
    case "plan_deck":
      return ["Which of the proposed swaps would you take first, and why?", "What is this deck still missing?", "Do the lab results say anything I can trust about these changes?"];
    case "review":
      return ["Which proposals should I say yes to first?", "Are any of these proposals redundant with each other?"];
    case "deck":
      return ["What are this deck's weakest cards?", "How could I make it faster without raising its bracket?"];
    case "precon":
      return ["What are the first five upgrades you'd make to this precon?", "How does this precon usually win?"];
    case "experiment":
      return ["What does this result actually tell me?", "How many more games would I need to be sure?"];
    default:
      return ["Which of my decks needs the most work?", "What should I buy next?"];
  }
}

/** Why the advisor isn't available, in a sentence, from the status's reason. */
export function unavailableText(reason: string | null | undefined, canSaveKey: boolean): string {
  switch (reason) {
    case "needs_key":
      return canSaveKey
        ? "To ask Claude, add your own Anthropic API key in Settings. Questions are billed to your Anthropic account."
        : "Ask Claude isn't available to your account on this server.";
    case "keys_off":
      return "Ask Claude is only available to this server's owner.";
    default:
      return "Ask Claude isn't set up on this server.";
  }
}

/** "Bryan's", "the server owner's". */
export function possessive(name: string): string {
  return `${name.trim() || "the server owner"}'s`;
}

/** "1 November", the day a paused shared key starts again (UTC, as the server counts months). */
export function resumeDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

interface ShareView {
  mode: string | null;
  shared_owner?: string | null;
  per_day: number | null;
  used_today: number;
  models: { id: string; label: string }[];
}

/**
 * The panel's plain line when you ask on the shared key, e.g. "On Bryan's shared key, with Claude
 * Haiku 5.5. 4 of 30 questions in the last 24 hours." Null in any other mode.
 */
export function sharedLine(s: ShareView, model: string): string | null {
  if (s.mode !== "shared") return null;
  const label = s.models.find((m) => m.id === model)?.label ?? s.models[0]?.label;
  const used = s.per_day != null ? ` ${s.used_today} of ${s.per_day} questions in the last 24 hours.` : "";
  return `On ${possessive(s.shared_owner ?? "")} shared key${label ? `, with ${label}` : ""}.${used}`;
}

/** Why shared questions are paused, and what to do meanwhile. */
export function pausedText(owner: string | null | undefined, until: string): string {
  return `${possessive(owner ?? "")} shared key has reached this month's limit. It's back on ${resumeDay(until)}. Until then you can add your own Anthropic API key in Settings.`;
}

/** What the panel says while Claude uses one of Yama's tools (server/src/mcp/tools.rs). */
export function toolActivity(name: string): string {
  switch (name) {
    case "overview":
      return "Looking at your decks and plans…";
    case "deck":
      return "Reading a deck…";
    case "plan_deck":
      return "Reading a plan…";
    case "review_queue":
      return "Reading your proposals…";
    case "find_cards":
      return "Searching cards…";
    case "card":
      return "Looking up cards…";
    case "check_list":
      return "Checking a list…";
    case "lab_runs":
    case "lab_run":
    case "lab_games":
      return "Reading lab results…";
    case "precon":
      return "Reading a precon…";
    case "changes":
      return "Checking changes waiting for you…";
    case "edit_deck":
    case "propose_swap":
    case "answer_review":
    case "mark_bought":
    case "mark_installed":
    case "start_lab_run":
    case "more_lab_games":
    case "run_lab_again":
    case "cancel_lab_run":
    case "add_to_collection":
    case "move_cards":
    case "set_condition":
      return "Staging a change for your review…";
    default:
      return "Looking something up…";
  }
}

/**
 * Settings' line on whose Claude your questions use, in the server's order (advisor/mod.rs,
 * access): the subscription for its owner, else your own key, else a shared key an admin granted.
 */
export function modeLine(s: AdvisorStatus): string {
  const owner = possessive(s.shared_owner ?? "");
  if (s.mode === "subscription")
    return s.subscription_connected === false
      ? "Your questions use this server's Claude subscription, which isn't connected yet: run deploy/advisor-token.sh on the Mac."
      : "Your questions use this server's Claude subscription.";
  if (s.mode === "own_key")
    return `Your questions use your own Anthropic API key ending ${s.key_hint ?? "…"}, billed to your Anthropic account.${s.shared_granted ? ` Remove it and they use ${owner} shared key instead.` : ""}`;
  if (s.mode === "shared") {
    const models = s.models.map((m) => m.label).join(" or ");
    return `Your questions use ${owner} shared API key${models ? ` (${models})` : ""}, which they pay for. If you add your own Anthropic API key, Yama uses yours instead, billed to your Anthropic account, with every model.`;
  }
  if (s.reason === "needs_key") return "Add your own Anthropic API key to ask Claude about your decks. Questions are billed to your Anthropic account.";
  if (s.reason === "keys_off") return "Ask Claude is only available to this server's owner.";
  return "Ask Claude isn't set up on this server.";
}
