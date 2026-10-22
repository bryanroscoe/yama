import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, childEnv, looksLikeApiKey, queryOptions, redact, runAdvice, secretMatches, validateRequest } from "./advisor.mjs";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN = "sk-ant-oat01-subscriptiontoken0123456789abcdef";
const ok = { mode: "subscription", model: "claude-opus-5-5", system: "Be helpful.", messages: [{ role: "user", content: "Hi" }] };

test("requests are checked field by field", () => {
  assert.equal(validateRequest(ok).ok, true);
  assert.equal(validateRequest({ ...ok, mode: "api_key", api_key: KEY }).ok, true);
  const cases = [
    [null, "JSON object"],
    [{ ...ok, mode: "free" }, "mode"],
    [{ ...ok, mode: "api_key" }, "api_key"],
    [{ ...ok, mode: "api_key", api_key: "hello" }, "api_key"],
    [{ ...ok, api_key: KEY }, "only sent with mode api_key"],
    [{ ...ok, model: "gpt-5" }, "model"],
    [{ ...ok, system: " " }, "system"],
    [{ ...ok, messages: [] }, "messages"],
    [{ ...ok, messages: [{ role: "system", content: "x" }] }, "role"],
    [{ ...ok, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, "last message"],
    [{ ...ok, effort: "max" }, "effort"],
  ];
  for (const [body, words] of cases) {
    const r = validateRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, new RegExp(words));
    assert.ok(!r.error.includes(KEY), "an error never repeats the key");
  }
});

test("only Anthropic-shaped keys pass", () => {
  assert.ok(looksLikeApiKey(KEY));
  assert.ok(!looksLikeApiKey("sk-ant-short"));
  assert.ok(!looksLikeApiKey(`${KEY} extra`));
  assert.ok(!looksLikeApiKey("sk-proj-abcdefghijklmnopqrstuvwxyz"));
});

test("earlier turns go in as a transcript before the new message", () => {
  assert.equal(buildPrompt([{ role: "user", content: "One" }]), "One");
  const p = buildPrompt([
    { role: "user", content: "One" },
    { role: "assistant", content: "Two" },
    { role: "user", content: "Three" },
  ]);
  assert.match(p, /<conversation_so_far>\n<user>\nOne\n<\/user>\n<assistant>\nTwo\n<\/assistant>\n<\/conversation_so_far>/);
  assert.match(p, /<new_message>\nThree\n<\/new_message>$/);
});

test("the Claude process gets one credential and nothing from this process", () => {
  process.env.ADVISOR_SECRET_FOR_TEST = "should-not-leak";
  const sub = childEnv({ mode: "subscription", oauthToken: TOKEN, home: "/tmp/h", path: "/usr/bin" });
  assert.equal(sub.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(sub.ANTHROPIC_API_KEY, undefined);
  const own = childEnv({ mode: "api_key", apiKey: KEY, oauthToken: TOKEN, home: "/tmp/h", path: "/usr/bin" });
  assert.equal(own.ANTHROPIC_API_KEY, KEY);
  assert.equal(own.CLAUDE_CODE_OAUTH_TOKEN, undefined, "a user's request never carries the subscription");
  for (const env of [sub, own]) {
    assert.equal(env.ADVISOR_SECRET_FOR_TEST, undefined);
    assert.equal(env.HOME, "/tmp/h");
  }
  assert.throws(() => childEnv({ mode: "subscription", oauthToken: "", home: "/tmp/h", path: "" }));
  assert.throws(() => childEnv({ mode: "api_key", apiKey: null, oauthToken: TOKEN, home: "/tmp/h", path: "" }));
});

test("the query has no tools, settings, MCP servers or saved session", () => {
  const req = validateRequest({ ...ok, effort: "low" }).req;
  const o = queryOptions({ req, env: {}, home: "/tmp/h", abortController: new AbortController() });
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(o.mcpServers, {});
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.maxTurns, 1);
  assert.equal(o.persistSession, false);
  assert.equal(o.systemPrompt, "Be helpful.");
  assert.equal(o.cwd, "/tmp/h");
  assert.equal(o.effort, "low");
});

test("credentials are redacted from anything shown or logged", () => {
  assert.equal(redact(`bad key ${KEY}`), "bad key [redacted]");
  assert.equal(redact("token abc123secretvalue here", ["abc123secretvalue"]), "token [redacted] here");
  assert.equal(redact("x".repeat(900)).length, 500);
});

test("the shared secret is compared exactly", () => {
  const s = "s".repeat(40);
  assert.ok(secretMatches(s, s));
  assert.ok(!secretMatches(`${s}x`, s));
  assert.ok(!secretMatches(undefined, s));
  assert.ok(!secretMatches(s, ""), "no secret configured means nobody gets in");
});

function fakeQuery(messages, seen) {
  return ({ prompt, options }) => {
    seen.push({ prompt, options });
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

const delta = (text) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });

test("streamed text is passed on, then done with usage", async () => {
  const seen = [];
  const out = [];
  const req = validateRequest({ ...ok, mode: "api_key", api_key: KEY }).req;
  const r = await runAdvice({
    req,
    queryFn: fakeQuery([delta("Hel"), delta("lo"), { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }, { type: "result", subtype: "success", is_error: false, result: "Hello", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01 }], seen),
    oauthToken: TOKEN,
    home: "/tmp/h",
    path: "/usr/bin",
    abortController: new AbortController(),
    write: (e) => out.push(e),
  });
  assert.equal(r.status, "done");
  assert.deepEqual(out, [
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    { type: "done", usage: { input_tokens: 10, output_tokens: 2 }, cost_usd: 0.01 },
  ]);
  assert.equal(seen[0].options.env.ANTHROPIC_API_KEY, KEY);
  assert.equal(seen[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("a whole answer without stream events is still sent", async () => {
  const out = [];
  await runAdvice({
    req: validateRequest(ok).req,
    queryFn: fakeQuery([{ type: "result", subtype: "success", is_error: false, result: "All at once", usage: {} }], []),
    oauthToken: TOKEN,
    home: "/tmp/h",
    path: "",
    write: (e) => out.push(e),
  });
  assert.deepEqual(out[0], { type: "text", text: "All at once" });
  assert.equal(out[1].cost_usd, null, "subscription answers carry no cost");
});

test("errors come back friendly and without credentials", async () => {
  const out = [];
  const req = validateRequest({ ...ok, mode: "api_key", api_key: KEY }).req;
  await runAdvice({
    req,
    queryFn: fakeQuery([{ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Invalid API key · Fix external API key" }] } }, { type: "result", subtype: "success", is_error: true, api_error_status: 401, result: `invalid x-api-key ${KEY}` }], []),
    oauthToken: TOKEN,
    home: "/tmp/h",
    path: "",
    write: (e) => out.push(e),
  });
  assert.equal(out.length, 1, "the CLI's own error text isn't passed on as an answer");
  assert.equal(out[0].type, "error");
  assert.equal(out[0].code, "auth");
  assert.ok(!JSON.stringify(out).includes(KEY));

  const out2 = [];
  await runAdvice({
    req,
    queryFn: () => {
      throw new Error(`spawn failed with ${KEY}`);
    },
    oauthToken: TOKEN,
    home: "/tmp/h",
    path: "",
    write: (e) => out2.push(e),
  });
  assert.equal(out2[0].type, "error");
  assert.ok(!JSON.stringify(out2).includes(KEY));
});

test("subscription mode without a token says so and never runs Claude", async () => {
  const out = [];
  const seen = [];
  const r = await runAdvice({ req: validateRequest(ok).req, queryFn: fakeQuery([], seen), oauthToken: "", home: "/tmp/h", path: "", write: (e) => out.push(e) });
  assert.equal(r.status, "error");
  assert.equal(out[0].code, "no_subscription");
  assert.equal(seen.length, 0);
});
