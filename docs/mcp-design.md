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
  - **Outside clients** (Claude Code, Claude Desktop through `mcp-remote`): a script key with the new
    scope `mcp` (Decks, Plans, Settings, where `plan:sync` keys are made). For example
    `claude mcp add --transport http yama https://yama.saget.org/mcp --header "Authorization: Bearer yama_pat_…"`.
    The key is the person's own; the Claude on the other end is theirs too, so no subscription is shared.
  - **Ask Claude:** for each question the yama server mints a one-question token (random, stored
    hashed, bound to the account and conversation, expires when the answer ends or after 15 minutes)
    and sends it to the sidecar with the request. The sidecar gives `query()` exactly one MCP server,
    `{type: "http", url: "http://yama:8080/mcp", headers: {Authorization: Bearer <token>}}`, allows
    only its tools, and raises `maxTurns` from 1 to 16. Still no Bash, files, web, settings or skills.
    The subscription rule is unchanged: only listed accounts ask on Bryan's subscription.
  - The claude.ai web and phone apps need OAuth for a custom connector. That is a later slice.
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
| `lab_runs`, `lab_run` | Experiments and rating runs, with the paired difference and its interval (and the lab's caveats) |
| `precon` | A precon's list, playgroup.gg data and the global rating |
| `games` | Real game results for a deck |

Write (staged):

| Tool | Becomes, when applied |
|---|---|
| `edit_deck` | A new version of a Yama deck: add, remove, replace cards (one version per change, with a note) |
| `propose_swap` | A planner idea for a plan deck (the existing `idea` op), so it goes through Review and the repo's pull |
| `answer_review` | A review answer (`review` op) |
| `mark_bought`, `mark_installed` | The existing `bought` and `installed` ops |
| `start_lab_run` | A paired experiment: a deck or list against the same deck with adds and cuts, under the lab's usual allowance |
| `add_to_collection`, `move_cards` | Collection ops (by name and printing) |

Plan swaps themselves can't be edited yet: imported plans are managed by the commander-decks repo
(its `swaps.json` is the source of truth), and Yama-made plans (planner slice 7) aren't built. So a
change to an imported plan goes in as an idea or a review answer and reaches the repo through
`pull.py`, as Bryan's own taps do. When slice 7 lands, `edit_swap` joins the write tools.

## Limits

- Tool calls count toward the asker's allowance: Ask Claude's daily question count, plus at most
  200 tool calls a day for open sign-up accounts (none for admins).
- `start_lab_run` uses the lab's own allowance and queue caps.
- Results are capped (a list is at most 300 lines, a search 60 cards) so one call can't fill the
  context window.
- Everything returned is the person's own data, marked as data: deck names, notes and reasons are
  typed by people and are never instructions.

## Slices

1. **Read tools and the endpoint** (built 2026-10-22; ARCHITECTURE.md has what shipped). `/mcp`, the `mcp` key scope, the read tools, the one-question
   token, and Ask Claude using tools (the context stays as a starting summary). Claude Code can
   connect with a key.
2. **Staged writes.** `assistant_changes`, the write tools, Apply and Discard in the panel and on
   the review list, `apply_change` for keys.
3. **OAuth** for the claude.ai and phone apps' connectors.
4. **`edit_swap`** once Yama-made plans exist (planner slice 7).
