// The advisor's logic, kept apart from the HTTP server so it can be tested without a network or
// a Claude login. See server.mjs for how it is served and README.md for why it exists.
//
// One request is one Claude query with no tools: no Bash, files, web, MCP, skills or settings.
// The yama server decides who may ask and with which credential; this side only checks the
// request's shape, runs the query in a throwaway home directory and streams the text back.

import { createHash, timingSafeEqual } from "node:crypto";

/** Models the yama server may ask for. */
export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export const EFFORTS = ["low", "medium", "high"];

export const LIMITS = {
  /** Request body, in bytes. */
  body: 1024 * 1024,
  /** System prompt (the yama server's instructions plus the user's data), in characters. */
  system: 240_000,
  /** Messages per request, and characters per message. */
  messages: 60,
  message: 100_000,
};

/**
 * Check a request body. Returns `{ ok: true, req }` with only the fields this side uses, or
 * `{ ok: false, error }` with a message that never repeats the key.
 */
export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("expected a JSON object");
  const { mode, api_key: apiKey, model, system, messages, effort } = body;
  if (mode !== "subscription" && mode !== "api_key") return bad('mode must be "subscription" or "api_key"');
  if (mode === "api_key") {
    if (typeof apiKey !== "string" || !looksLikeApiKey(apiKey)) return bad("api_key is missing or isn't an Anthropic API key");
  } else if (apiKey !== undefined && apiKey !== null) {
    return bad("api_key is only sent with mode api_key");
  }
  if (!MODELS.includes(model)) return bad(`model must be one of ${MODELS.join(", ")}`);
  if (typeof system !== "string" || !system.trim()) return bad("system is missing");
  if (system.length > LIMITS.system) return bad(`system is longer than ${LIMITS.system} characters`);
  if (!Array.isArray(messages) || messages.length === 0) return bad("messages must be a non-empty array");
  if (messages.length > LIMITS.messages) return bad(`at most ${LIMITS.messages} messages`);
  for (const [i, m] of messages.entries()) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return bad(`messages[${i}].role must be user or assistant`);
    if (typeof m.content !== "string" || !m.content.trim()) return bad(`messages[${i}].content is empty`);
    if (m.content.length > LIMITS.message) return bad(`messages[${i}] is longer than ${LIMITS.message} characters`);
  }
  if (messages.at(-1).role !== "user") return bad("the last message must be the user's");
  if (effort !== undefined && effort !== null && !EFFORTS.includes(effort)) return bad(`effort must be one of ${EFFORTS.join(", ")}`);
  const { tools } = body;
  if (tools !== undefined && tools !== null) {
    if (typeof tools !== "object" || typeof tools.url !== "string" || !/^https?:\/\/[^\s]+$/.test(tools.url) || tools.url.length > 300) return bad("tools.url must be an http(s) URL");
    if (typeof tools.token !== "string" || !/^yama_ask_[A-Za-z0-9]{16,200}$/.test(tools.token)) return bad("tools.token isn't a Yama question token");
  }
  return {
    ok: true,
    req: {
      mode,
      apiKey: mode === "api_key" ? apiKey : null,
      model,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      effort: effort ?? null,
      tools: tools ? { url: tools.url, token: tools.token } : null,
    },
  };
}

function bad(error) {
  return { ok: false, error };
}

/** Anthropic API keys start with `sk-ant-`; no spaces, sane length. */
export function looksLikeApiKey(s) {
  return /^sk-ant-[A-Za-z0-9_-]{16,400}$/.test(s);
}

/**
 * The query's prompt. A query takes one user turn, so earlier turns go in as a transcript the
 * model can read, and the newest message follows it.
 */
export function buildPrompt(messages) {
  const last = messages.at(-1).content;
  if (messages.length === 1) return last;
  const earlier = messages
    .slice(0, -1)
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join("\n");
  return `<conversation_so_far>\n${earlier}\n</conversation_so_far>\n\n<new_message>\n${last}\n</new_message>`;
}

/**
 * The Claude process's whole environment. It is built from nothing, never copied from this
 * process, so the shared secret and the other mode's credential can't leak into it: subscription
 * mode carries only the OAuth token, API-key mode only the user's key.
 */
export function childEnv({ mode, apiKey, oauthToken, home, path }) {
  const env = {
    PATH: path,
    HOME: home,
    CLAUDE_CONFIG_DIR: `${home}/.claude`,
    TMPDIR: home,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "yama-advisor/1",
  };
  if (mode === "subscription") {
    if (!oauthToken) throw new Error("no subscription token");
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  } else {
    if (!apiKey) throw new Error("no API key");
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return env;
}

/** Turns Claude may take when it has Yama's tools: each tool call and its answer is one. */
export const TOOL_TURNS = 16;

/**
 * Options for the Agent SDK's `query()`: our system prompt instead of Claude Code's, no settings,
 * skills or CLAUDE.md, nothing saved, and none of Claude Code's own tools (no Bash, files or web).
 * With `req.tools`, exactly one MCP server, Yama's tools for this question's account
 * (server/src/mcp), and only its tools allowed; without, one turn and no tools at all.
 */
export function queryOptions({ req, env, home, abortController }) {
  const yama = req.tools ? { yama: { type: "http", url: req.tools.url, headers: { Authorization: `Bearer ${req.tools.token}` } } } : {};
  const options = {
    model: req.model,
    systemPrompt: req.system,
    tools: [],
    allowedTools: req.tools ? ["mcp__yama"] : [],
    settingSources: [],
    mcpServers: yama,
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    maxTurns: req.tools ? TOOL_TURNS : 1,
    persistSession: false,
    includePartialMessages: true,
    cwd: home,
    env,
    abortController,
    // The CLI's stderr can echo request details; it is dropped, never logged.
    stderr: () => {},
  };
  if (req.effort) options.effort = req.effort;
  return options;
}

/** Replace anything that looks like a credential, and the given secrets, in text bound for logs or the client. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

/** Constant-time comparison of the shared secret (both sides hashed, so lengths don't leak). */
export function secretMatches(given, expected) {
  if (!expected || typeof given !== "string" || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Run one request and write NDJSON events with `write(obj)`:
 * `{type:"text", text}` as the answer streams, then `{type:"done", usage, cost_usd}` or
 * `{type:"error", message}`. `queryFn` is the SDK's `query` (a fake in tests).
 */
export async function runAdvice({ req, queryFn, oauthToken, home, path, abortController, write }) {
  const secrets = [oauthToken, req.apiKey, req.tools?.token];
  let env;
  try {
    env = childEnv({ mode: req.mode, apiKey: req.apiKey, oauthToken, home, path });
  } catch {
    write({ type: "error", code: req.mode === "subscription" ? "no_subscription" : "no_key", message: req.mode === "subscription" ? "The subscription isn't connected on the server yet." : "No API key was sent." });
    return { status: "error" };
  }
  let streamed = 0;
  let finished = false;
  // A whole turn without stream events is held until the result says it succeeded: when the
  // credentials are refused, the CLI reports the error as an assistant message too.
  let whole = "";
  try {
    const q = queryFn({ prompt: buildPrompt(req.messages), options: queryOptions({ req, env, home, abortController }) });
    // Text from one turn and the next (around a tool call) is kept apart by a blank line.
    let needBreak = false;
    for await (const msg of q) {
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "message_start" && streamed > 0) {
          needBreak = true;
        } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          // Only the tool's short name: never its arguments.
          write({ type: "tool", name: String(ev.content_block.name ?? "").replace(/^mcp__yama__/, "").slice(0, 60) });
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          const text = needBreak ? `\n\n${ev.delta.text}` : ev.delta.text;
          needBreak = false;
          streamed += text.length;
          write({ type: "text", text });
        }
      } else if (msg.type === "assistant" && streamed === 0 && !msg.error) {
        whole += (msg.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      } else if (msg.type === "result") {
        finished = true;
        if (msg.subtype === "success" && !msg.is_error) {
          const text = streamed === 0 ? whole || msg.result : "";
          if (text) write({ type: "text", text });
          write({ type: "done", usage: usageOf(msg), cost_usd: req.mode === "api_key" ? (msg.total_cost_usd ?? null) : null });
          return { status: "done" };
        }
        write({ type: "error", code: errorCode(msg), message: friendlyError(msg, secrets) });
        return { status: "error" };
      }
    }
    if (!finished) {
      write({ type: "error", code: "incomplete", message: "Claude stopped without finishing the answer." });
    }
    return { status: "error" };
  } catch (e) {
    if (abortController?.signal.aborted) return { status: "stopped" };
    write({ type: "error", code: "failed", message: friendlyError({ errors: [e?.message ?? String(e)] }, secrets) });
    return { status: "error" };
  }
}

function usageOf(msg) {
  const u = msg.usage ?? {};
  return { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null };
}

function errorCode(msg) {
  const status = msg.api_error_status;
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 529 || (status && status >= 500)) return "unavailable";
  return "failed";
}

function friendlyError(msg, secrets) {
  const status = msg.api_error_status;
  if (msg.subtype === "error_max_turns") return "Claude used every step it's allowed for one question before finishing. Ask something narrower, or ask it to carry on.";
  if (status === 401 || status === 403) return "Anthropic refused the credentials. The key or subscription token may be wrong, revoked or expired.";
  if (status === 429) return "Claude's usage limit was reached. Try again later.";
  if (status && status >= 500) return "Claude is busy or unavailable right now. Try again in a minute.";
  const detail = [msg.result, ...(msg.errors ?? [])].filter(Boolean).join(" ");
  return redact(detail || "Claude couldn't answer.", secrets);
}
