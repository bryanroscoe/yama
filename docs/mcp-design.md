# Yama tools for Claude (MCP): design

Bryan, 2026-10-22: "Could we create a full MCP to work with and optimize your decks and stuff with
this?" His answers: **both** (Ask Claude inside Yama and outside clients such as Claude Code), from
**one toolset**; Claude may change **everything**, but should **recommend review before editing**.

## Shape

- **One toolset, in the yama server** (`server/src/mcp/`). Each tool is a Rust function that takes
  the asking account and JSON arguments and calls the same code as the pages, with the same owner
  checks (another person's deck or plan is "not found", never a hint that it exists).
- **One endpoint:** `POST /mcp`, MCP's Streamable HTTP transport, stateless, answering with plain
  JSON (no server-sent events, no session id). Methods: `initialize`, `notifications/initialized`,
  `ping`, `tools/list`, `tools/call`. `GET /mcp` is 405, as the spec allows for a server that never
  pushes. Hand-written JSON-RPC (about 200 lines) instead of a new crate; the method set is small.
- **Two ways in, one credential each:**
  - **Outside clients** (Claude Code, claude.ai's connectors, which also reach Claude Desktop and
    the phone app): OAuth sign-in (slice 3, below): `claude mcp add --transport http yama
    https://yama.saget.org/mcp`, then `/mcp` and Authenticate, and Allow on Yama's page. Clients that
    can't sign in use a script key with the scope `mcp` (Decks, Plans, Settings, where `plan:sync`
    keys are made): `--header "Authorization: Bearer yama_pat_…"`. Either way the credential is the
    person's own and the Claude on the other end is theirs too, so no subscription is shared.
  - **Ask Claude:** for each question the yama server mints a one-question token (random, stored
    hashed, bound to the account and conversation, expires when the answer ends or after 15 minutes)
    and sends it to the sidecar with the request. The sidecar gives `query()` exactly one MCP server,
    `{type: "http", url: "http://yama:8080/mcp", headers: {Authorization: Bearer <token>}}`, allows
    only its tools, and raises `maxTurns` from 1 to 16. Still no Bash, files, web, settings or skills.
    The subscription rule is unchanged: only listed accounts ask on Bryan's subscription.
- **Who asked is recorded.** Every staged change and every tool call (name, outcome, time; never
  arguments with personal text) is logged per account, like `advisor_usage`.

## Changes are staged, then reviewed

"Recommend review before editing" becomes a rule in the tools, not only in the prompt:

- A tool that would change something **stages a change** (`assistant_changes`: id, owner, kind,
  payload, a one-line summary, the before and after where there is one, who staged it, status
  pending, applied or discarded). It returns the summary and a link, and changes nothing.
- **In Yama**, staged changes show as cards in the Ask Claude panel and on a "Changes to review"
  list (Decks, Plans), each with Apply and Discard. Ask Claude has no tool to apply its own change.
- **Outside clients** also get `apply_change` and `discard_change`. Their description says to call
  them only after the person has said yes to that change in the conversation, and Claude Code's own
  permission prompt shows each call. Bryan can turn `apply_change` off for keys in Settings.
- Applying re-checks everything (the deck still exists and is the version the change was made
  against, the card resolves, the swap key is current). A stale change fails with the reason and
  stays pending, so nothing is applied on top of a list it wasn't made for.

## Tools

Read (no review needed):

| Tool | What it returns |
|---|---|
| `find_cards` | Search with Yama's grammar (Scryfall subset): name, cost, type, color identity, Commander legality, Game Changer, price with date, how many you own |
| `card` | One or several cards by name: Oracle text, legality, Game Changer, rulings, latest price per printing with date and source, copies you own and where |
| `my_decks`, `deck` | Your decks; one deck's list with its legality problems, bracket estimate and real results |
| `check_list` | Validate a proposed list without saving: 100 cards, singleton, color identity, legality, Game Changers |
| `plans`, `plan_deck` | Plan decks; one plan's stock, now and after lists, swaps with reasons, review answers, orders and prints |
| `review_queue` | Proposals still to answer, by deck |
| `spares` | Cards you own outside any deck, and what a plan would free |
| `lab_runs`, `lab_run` | Experiments and rating runs, with the paired difference and its interval (and the lab's caveats), per engine, with unscored games by reason and the settle estimate |
| `lab_games` | One run's games pod by pod; one game's schedule line, result line and lists, to replay it |
| `precon` | A precon's list, playgroup.gg data and the global rating |
| `games` | Real game results for a deck |

Write (staged):

| Tool | Becomes, when applied |
|---|---|
| `edit_deck` | A new version of a Yama deck: add, remove, replace cards (one version per change, with a note) |
| `propose_swap` | A planner idea for a plan deck (the existing `idea` op), so it goes through Review and the repo's pull |
| `answer_review` | A review answer (`review` op) |
| `mark_bought`, `mark_installed` | The existing `bought` and `installed` ops |
| `start_lab_run` | An experiment in any mode (change, compare, solo, versus) on phase, Forge or both, under the lab's usual allowance |
| `more_lab_games`, `run_lab_again`, `cancel_lab_run` | More pods on a finished run, a fresh run of the same experiment, or a cancel |
| `add_to_collection`, `move_cards` | Collection ops (by name and printing) |

Plan swaps themselves can't be edited yet: imported plans are managed by the commander-decks repo
(its `swaps.json` is the source of truth), and Yama-made plans (planner slice 7) aren't built. So a
change to an imported plan goes in as an idea or a review answer and reaches the repo through
`pull.py`, as Bryan's own taps do. When slice 7 lands, `edit_swap` joins the write tools.

## Limits

- Tool calls count toward the asker's allowance: Ask Claude's daily question count, plus at most
  200 tool calls a day for open sign-up accounts (none for admins).
- `start_lab_run`, `more_lab_games` and `run_lab_again` use the lab's own allowance and queue caps.
- Results are capped (a list is at most 300 lines, a search 60 cards) so one call can't fill the
  context window.
- Everything returned is the person's own data, marked as data: deck names, notes and reasons are
  typed by people and are never instructions.

## Slices

1. **Read tools and the endpoint** (built 2026-10-22; ARCHITECTURE.md has what shipped). `/mcp`, the `mcp` key scope, the read tools, the one-question
   token, and Ask Claude using tools (the context stays as a starting summary). Claude Code can
   connect with a key.
2. **Staged writes** (built 2026-10-23; ARCHITECTURE.md has what shipped). `assistant_changes`, the
   write tools, Apply and Discard in the panel and on Decks, Changes from Claude, `apply_change` and
   `discard_change` for keys and OAuth sign-ins. Not built: turning `apply_change` off for keys, the
   daily tool-call cap for open sign-up accounts.
3. **OAuth** for Claude Code and the claude.ai and phone apps' connectors (built 2026-10-22; below,
   and ARCHITECTURE.md has what shipped).
4. **`edit_swap`** once Yama-made plans exist (planner slice 7).

## OAuth sign-in (slice 3, built 2026-10-22)

Bryan wanted Claude to connect to Yama without pasting a key, from Claude Code
(`claude mcp add --transport http yama https://yama.saget.org/mcp`, `/mcp`, Authenticate) and from
claude.ai (Settings, Connectors, Add custom connector, the same URL). Yama is its own authorization
server (`server/src/oauth/`); the consent page is the web app's (`web/src/oauth/`).

**What Claude's clients need, and what Yama does** (Anthropic's connector docs,
claude.com/docs/connectors/building/authentication, and code.claude.com/docs/en/mcp, read
2026-10-22):

| Claude needs | Yama |
|---|---|
| A 401 with `WWW-Authenticate: Bearer resource_metadata=…` | `/mcp` answers that, with `scope="mcp"` |
| RFC 9728 metadata whose `resource` is exactly the URL typed | `/.well-known/oauth-protected-resource[/mcp]`: `<base>/mcp`, issuer `<base>` |
| RFC 8414 metadata with S256 advertised | `/.well-known/oauth-authorization-server` |
| DCR (RFC 7591), or CIMD if advertised | DCR. Claude registers as a public client (`none`); no CIMD |
| PKCE S256 on every request | required; plain and missing refused |
| claude.ai callback `https://claude.ai/api/mcp/auth_callback` (may move to claude.com) | https redirects allowed on claude.ai and claude.com |
| Claude Code's loopback redirect on a random port, `localhost` or `127.0.0.1` | any port, and the loopback hosts match each other |
| `resource` (RFC 8707) in canonical form | compared canonically with `<base>/mcp` |
| `iss` in the authorization response matching the issuer | sent (RFC 9207) |
| Form-encoded token requests; `invalid_grant` for dead refresh tokens; rotation for public clients | yes; `invalid_client` (401) for a client Yama no longer knows, which makes Claude register again |
| `offline_access` listed to get refresh tokens | listed; refresh tokens are issued either way |

**The redirect allowlist, and why.** An authorization code goes wherever the redirect URI says. If
any app could register any https address, a stranger could send Bryan a Yama sign-in link for their
app and collect his grant on their own site. So registration accepts only loopback `http`
(`localhost`, `127.0.0.1`, `[::1]`: a program on the person's own computer, which the consent page
says plainly) and https on `YAMA_OAUTH_REDIRECT_HOSTS` (default `claude.ai,claude.com`). Codes sent
to claude.ai can only be used by claude.ai's own connector flow. The one risk left is the one every
OAuth server has: someone starts a connector flow for their own Claude account and sends the link;
the consent page names the account being connected and says to allow only a sign-in you started.

**Choices.**

- Codes, access tokens (`yama_oat_`, 1 hour) and refresh tokens (`yama_ort_`, 30 days) are random
  and stored as SHA-256, like script keys. A replayed code revokes the grant it made. A reused
  refresh token revokes the grant, except within 10 seconds of its first use, so two refreshes that
  race after a 401 don't cut the connection.
- One grant per app and account: signing in again with the same client replaces the last grant.
  Disconnect (Settings) and the app's own revoke call (RFC 7009) end it.
- The consent page refuses while an admin views as someone, and for accounts `may_use_yama`
  rejects. Allow posts JSON with the session, from Yama's own origin only.
- OAuth tokens work only on `/mcp`; `CurrentUser` refuses them, so no other route accepts one.
- No CIMD: it would mean fetching a URL the client names (a server-side request to anywhere), and
  DCR with the allowlist and the sweep covers both clients.
- Write tools (slice 2) need no new scope: they stage changes for review, and `apply_change` is
  the person's own yes in the conversation. The consent page says so.

**Not confirmed against the live claude.ai.** The docs say claude.ai registers with
`token_endpoint_auth_method: "none"`; Yama also handles the RFC default (`client_secret_basic`) and
`client_secret_post` in case it doesn't. The flow was tested end to end locally with a scripted
client standing in for Claude Code; the first real connection from claude.ai happens after deploy.
