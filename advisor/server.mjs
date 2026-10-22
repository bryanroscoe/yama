// Yama's advisor sidecar: an HTTP server on the yama container's private Docker network that runs
// Claude (through the Agent SDK) with no tools and streams the answer back as NDJSON.
//
//   POST /advise   x-advisor-secret: <ADVISOR_SECRET>   body: see validateRequest in advisor.mjs
//   GET  /health   x-advisor-secret: ...                → {"ok":true,"subscription":true|false}
//   GET  /healthz  (no secret; for Docker)              → ok
//
// Environment: ADVISOR_SECRET (required; shared with the yama server as YAMA_ADVISOR_SECRET),
// CLAUDE_CODE_OAUTH_TOKEN (optional; Bryan's `claude setup-token` token, for subscription mode),
// ADVISOR_PORT (default 8790), ADVISOR_MAX_CONCURRENT (default 3). Both secrets are read once and
// removed from this process's environment, so nothing started later can inherit them.
//
// It logs one line per request (mode, model, outcome, time, tokens) and never a prompt, answer,
// key or token.

import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS, redact, runAdvice, secretMatches, validateRequest } from "./advisor.mjs";

const SECRET = process.env.ADVISOR_SECRET ?? "";
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
delete process.env.ADVISOR_SECRET;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
const PORT = Number(process.env.ADVISOR_PORT ?? 8790);
const MAX_CONCURRENT = Number(process.env.ADVISOR_MAX_CONCURRENT ?? 3);
const CHILD_PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

if (SECRET.length < 32) {
  console.error("ADVISOR_SECRET is missing or shorter than 32 characters; refusing to start");
  process.exit(1);
}

let running = 0;

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.body) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function advise(req, res) {
  if (running >= MAX_CONCURRENT) return json(res, 503, { error: "The advisor is busy. Try again in a moment." });
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return json(res, e.status ?? 400, { error: e.status === 413 ? "request too large" : "couldn't read the request" });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: "body isn't JSON" });
  }
  const checked = validateRequest(body);
  if (!checked.ok) return json(res, 400, { error: checked.error });
  const r = checked.req;

  running += 1;
  const started = Date.now();
  const abortController = new AbortController();
  // The yama server hangs up when its browser does: stop Claude too.
  res.on("close", () => {
    if (!res.writableFinished) abortController.abort();
  });
  const home = await mkdtemp(path.join(tmpdir(), "advisor-"));
  let usage = null;
  let outcome = "error";
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  try {
    const result = await runAdvice({
      req: r,
      queryFn: query,
      oauthToken: OAUTH_TOKEN,
      home,
      path: CHILD_PATH,
      abortController,
      write: (ev) => {
        if (ev.type === "done") usage = ev.usage;
        if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
      },
    });
    outcome = result.status;
  } finally {
    running -= 1;
    if (!res.writableEnded) res.end();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    const tokens = usage ? ` in=${usage.input_tokens ?? "?"} out=${usage.output_tokens ?? "?"}` : "";
    console.log(`advise mode=${r.mode} model=${r.model} outcome=${outcome} ms=${Date.now() - started}${tokens}`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://advisor");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (!secretMatches(req.headers["x-advisor-secret"], SECRET)) return json(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, subscription: OAUTH_TOKEN.length > 0 });
  if (req.method === "POST" && url.pathname === "/advise") {
    return advise(req, res).catch((e) => {
      console.error(`advise failed: ${redact(e?.message, [OAUTH_TOKEN, SECRET])}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  }
  json(res, 404, { error: "not found" });
});

server.requestTimeout = 10 * 60 * 1000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`yama-advisor listening on ${PORT} (subscription token ${OAUTH_TOKEN ? "set" : "not set"})`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
