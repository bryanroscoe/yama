# Yama tools for Claude (MCP): design

User-facing features, setup and examples are published at
[the public MCP guide](https://yama.ing/docs/mcp/) (`web/public/docs/mcp/index.html`).

Local buying follows [the shopping workflow](local-shopping-workflow.md), exposed
to MCP clients as `yama://shopping/workflow`. It distinguishes current build
verification, private research evidence, active plan/trip stock, requested refreshes,
listing and cart links, optional real replacements for proxies, and sell buylists.

Bryan, 2026-10-22: "Could we create a full MCP to work with and optimize your decks and stuff with
this?" His answers: **both** (Ask Claude inside Yama and outside clients such as Claude Code), from
**one toolset**; Claude may change **everything**, but should **recommend review before editing**.

## Shape

- **One toolset, in the yama server** (`server/src/mcp/`). Each tool is a Rust function that takes
  the asking account and JSON arguments and calls the same code as the pages, with the same owner
  checks (another person's deck or plan is "not found", never a hint that it exists).
- **One definition per tool** (`mcp/registry.rs`, 2026-11-11). A `Tool` holds its name, the older
  names it still answers to (`aliases`, never listed), title, description, kind (read, outside,
  stage or write, which decides its annotations), who is offered it, its argument schema, its
  handler and, for a staging tool, the kind it stores and the function that applies it.
  `tools/list`, `tools/call` and applying a staged change all read that entry; before, a tool was
  spread over two tables and three `match`es. The entries live beside their code
  (`tools::TOOLS`, `research::TOOLS`). To add a tool: write its handler, add its entry, add it to
  the public guide, and regenerate the catalog snapshot. A new stored kind needs no migration:
  `assistant_changes.kind` lost its CHECK in 0076 (the table had been recreated nine times to
  add a kind, and one tool shipped without its kind), and the tool table is the one list of
  kinds. Arguments are read with `mcp/args.rs`,
  one set of helpers with one set of messages.
- **One endpoint:** `POST /mcp`, MCP's Streamable HTTP transport, stateless, answering with plain
  JSON (no server-sent events, no session id). Methods: `initialize`, `notifications/initialized`,
  `ping`, `tools/list`, `tools/call`. `GET /mcp` is 405, as the spec allows for a server that never
  pushes. Hand-written JSON-RPC (about 200 lines) instead of a new crate; the method set is small.
- **Two ways in, one credential each:**
  - **Outside clients** (Claude Code, claude.ai's connectors, which also reach Claude Desktop and
    the phone app): OAuth sign-in (slice 3, below): `claude mcp add --transport http yama
    https://yama.ing/mcp`, then `/mcp` and Authenticate, and Allow on Yama's page. Clients that
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
  permission prompt shows each call. Turning `apply_change` off for keys was planned and isn't built; an OAuth sign-in can be limited to reading or staging on the consent page (below).
- Applying re-checks everything (the deck still exists and is the version the change was made
  against, the card resolves, the swap key is current). A stale change fails with the reason and
  stays pending, so nothing is applied on top of a list it wasn't made for.
- **Staging is idempotent when the caller wants it** (2026-11-11). Every staging tool takes an
  optional `op_id` (8 to 64 letters, digits, hyphens or underscores; a UUID). A second call with
  the same `op_id` and the same arguments answers with the change the first one staged, whatever
  became of it, and stages nothing; the answer comes before any check, so a retry after the
  change was applied doesn't fail on the new list. An `op_id` reused for a different request
  (another tool, or other arguments) is refused: answering with the earlier change would tell
  the caller a change was staged that wasn't, and a yes to it would apply the wrong one. Ids are
  per account (`assistant_changes.op_id`, unique with the owner; `op_hash` is the request).
  Without one, a repeat stages again.
- **One apply or discard at a time per account** (`changes::owner_lock`, 2026-11-11), so a change
  can't be applied twice at once. Before, one lock covered every account, and a slow apply held
  up everyone else's.

## Tools

**UI and MCP parity (2026-11-09).** Bryan: anything the UI can do the MCP should do, and the
reverse, for the most part. The capability map, the backlog and the list of things with no good
UI design yet are in [ui-mcp-parity.md](ui-mcp-parity.md). New read tools reuse the page's own
function (`list_games`, `get_game`, `list_playgroups`, `get_collection_summary`); new writes are staged.

Commander research and workflow extensions (2026-10-27) are implemented in
`server/src/mcp/research/`; see [the capability map, provenance and limits](mcp-parity.md).
They use this same endpoint and review flow. The protocol also exposes workflow prompts and
owner-checked resources. `save_deck` stages a complete new/replacement list, never a direct save.

Private research adds `get_research`, `save_research` and `review_research`; see
[its format and review semantics](research-format.md). The latter two store advice and stated
preferences directly, an explicit exception to staged execution writes. They never alter a deck,
inventory, planner approval, order or game. A saved note does move the plans that track its
builds: they follow the refreshed note. So `save_research` is annotated as able to destroy
(it replaces the note's earlier revision), and a document that drops a deck or build a plan
tracks, which would archive that plan and retire its swaps, is refused with the plans named and
nothing saved unless the call says `stop_plans: true` (2026-11-11). Ask Claude can't pass it, as
it can't apply a change; the page's own upload is unchanged. Compact reads and deck/build/scenario filters avoid
returning every list to a client that only needs one decision.

**Deck plans (2026-11-04).** Bryan: "I would expect plans to be part of the MCP." A deck plan is a
note's deck (its builds, swaps and reasons) and, once one build is chosen, that build tracked as
the deck's plan: `track_build` stages it, and applying makes a Yama-made plan deck that Buy, Trip,
prints, marks and the plan tools work on (ARCHITECTURE.md, "Plans from notes"). `get_overview` counts the
notes and lists the newest few with their decks, builds and which one each tracks, beside the
plans; its `notes` section lists every note deck. `get_plan` on an untracked note deck lists its
builds. Saving the note again updates the plan.

Read (no review needed):

| Tool | What it returns |
|---|---|
| `search_cards` | Search with Yama's grammar (Scryfall subset): name, cost, type, color identity, Commander legality, Game Changer, price with date, how many you own |
| `get_cards` | One or several cards by name: Oracle text, legality, Game Changer, rulings, latest price per printing with date and source, copies you own and where |
| `get_overview`, `get_deck` | Your decks; one deck's list with its legality problems, bracket estimate and real results |
| `check_deck_list` | Validate a proposed list without saving: 100 cards, singleton, color identity, legality, Game Changers |
| `get_overview`, `get_plan` | Deck plans; one plan's stock, now and after lists, swaps with reasons, review answers, orders and prints |
| `get_review_queue` | Proposals still to answer, by deck |
| `get_shopping_trip` | Which of their stores to visit: the fewest stores covering the most cards under their local buy rule and store preferences (optionally only the stores they're going to this time), each store's cards, total and cart link or card search links, what to print instead and why with a TCGplayer Mass Entry link, and the real-card wishlist by price tier ([shopping-design.md](shopping-design.md)) |
| `get_shopping_settings` | Their buy rule in force, every dated rule set with its origin, the sealed precon cap, and each store's level, place in their order and premium |
| `get_shopping_list` | Every want on their one list (planned buys, proposals, cards and sealed products they added, the wishlist count) and where the trip puts each card, or why not |
| `compare_with_friend` | A friend's profile by handle: the cards on their shared want list this account owns real copies of (and how many are in deck boxes), and the cards on this account's shopping list in the friend's shared collection, with printings and conditions. Reads only what the friend shares (Sharing, "Looking for") |
| `get_store_stock` | One store's newest snapshot answers for cards (default: the trip's cards): price, condition, finish and quantity where given, or not in stock, with the time read |
| `list_collection_cards` | Cards you own, with `outside_decks` for the ones in no deck box (`spares` was planned and never built) |
| `list_lab_runs`, `get_lab_run` | Your experiments and rating runs, with live progress, the paired difference and its interval (and the lab's caveats), per engine, with unscored games by reason and the settle estimate. Admins also see the count of earlier Phase games ahead in the shared queue; for both-engine runs, ETA and queue position are Phase-only. No other account's run or deck details are exposed. |
| `list_lab_games` | One run's games pod by pod; one game's schedule line, result line and lists, to replay it; a head-to-head or tournament run's tables for one deck (`deck`) or one table (`table`), with finish order, who went first and knockout turns |
| `get_precon` | A precon's list, playgroup.gg data and the global rating |
| `list_games` | Real game results for a deck |

Write (staged):

| Tool | Becomes, when applied |
|---|---|
| `edit_deck` | A new version of a Yama deck: add, remove, replace cards (one version per change, with a note) |
| `delete_deck` | Deletes (archives) a deck or one configuration, the deck page's Delete: its configurations become decks of their own unless `configurations` is true, which deletes the ones named when it was staged |
| `track_build` | One build of a deck in a saved note becomes that deck's next plan version, waiting for their OK (`POST /api/plan/from-note` with `proposed: true`), or switches or stops it (`build: null`) |
| `approve_plan` | Approves a deck's waiting plan version whole (skips and open-question answers included), or keeps the version before it: the `plan` op (`server/src/plan/versions.rs`) |
| `propose_swap` | A planner idea for a plan deck (the existing `idea` op), so it goes through Review and the repo's pull |
| `answer_review` | A review answer (`review` op) |
| `mark_bought`, `mark_installed` | The existing `bought` and `installed` ops |
| `start_lab_run` | An experiment in any mode (change, compare, solo, versus) on phase, Forge or both, under the lab's usual allowance |
| `add_lab_games`, `rerun_lab_run`, `cancel_lab_run` | More pods on a finished run, a fresh run of the same experiment, or a cancel |
| `add_to_collection`, `move_cards`, `set_condition` | Collection ops (by name and printing; a condition for every copy in a container, or one card's) |
| `edit_copies`, `remove_from_collection`, `create_container` | The copies of a card in one container: a finish or proxy mark for some or all of them (the ones it would change), a note or price paid for all of them; copies that leave the collection, pinned row by row when staged and told apart by set and number, finish or proxy when they are not all alike; a new binder, deck box, box or list (2026-11-11) |
| `update_deck` | A deck's name, its declared bracket (1 to 5, or cleared), or both (2026-11-11) |
| `remove_wish` | One want they added, off their shopping list, by name or id; two with one name are refused until the id says which (2026-11-11) |
| `set_shopping_rules` | A new buy rule and sealed cap as a rule set from the day they apply it (parts left out keep the rule in force) |
| `set_store_preference` | One store's level, place in their order of how easy stores are to get to, and a favourite's premium (parts left out stay) |
| `add_wish` | A card or sealed product on their shopping list (need or along the way; for a Yama deck or a label) |
| `check_stores` | Read their stores' stock when they apply it (stores and cards default to the trip's; optional YesTCG), as dated snapshots |
| `swap_in_prints` | When prints arrive: a plan deck's now list to its after-prints list in Yama (the linked deck's new version, prints into its box as proxies, cut cards to the deck that takes them, its swap bag box or Spares, installed ticks), the same as the plan page's "Swap in the prints" (`server/src/plan/swap_in.rs`) |

Plan swaps themselves can't be edited yet: imported plans are managed by the commander-decks repo
(its `swaps.json` is the source of truth), and Yama-made plans (planner slice 7) aren't built. So a
change to an imported plan goes in as an idea or a review answer and reaches the repo through
`pull.py`, as Bryan's own taps do. When slice 7 lands, `edit_swap` joins the write tools.

## Limits

- Tool calls are counted per account (built 2026-11-11, `mcp::count_call`, `limits.rs`): at most
  120 a minute for everyone but admins, and at most 200 a day for an account that joined through
  open sign-up. Invited accounts and admins have no daily count. A refused call is a tool result
  that says how long to wait, not an HTTP 429, so the assistant reads the reason instead of its
  client retrying. Reading a resource runs a tool, so it counts too. The counts are in memory, like the other rate limits: a restart starts them
  again, so they stop a runaway loop and are not a quota. Ask Claude's own daily question count is
  separate.
- `start_lab_run`, `add_lab_games` and `rerun_lab_run` use the lab's own allowance and queue caps.
- Results are capped (a list is at most 300 lines, a search 60 cards) so one call can't fill the
  context window.
- **Default answers have a size budget** (2026-11-11). A client rejects an answer above its own
  limit: `get_overview` on Bryan's account was 62,304 characters and never arrived. So what a tool
  says when nothing asks it for more has a budget of 20,000 characters, 8,000 for `get_overview`,
  and `mcp/tests_budget.rs` fails if one grows past that on a fixture account larger than Bryan's,
  with ids and fields as long as real ones. The lists these tools page through are bounded by
  how they are built, not only on the fixture: a page is a number of rows and each row has a
  longest length (`get_overview`'s summary is at most about 15,000 characters whatever the account
  holds, a section page about 19,000). Tools that return one thing whole (`get_deck`, `get_plan`,
  `get_research` with `full`) are as large as that thing; the results-and-paging work gives those a
  cursor too. The rest is reached by asking: `get_overview` takes `section` (decks, plans, notes),
  whose rows are decks and their configurations, plans, or note decks; `get_review_queue` lists 15
  waiting swaps at a time, for every plan or one; `list_changes` lists 25 and gives one whole by `id`;
  `list_games` 10; `list_collection_cards` 20. JSON answers are compact, not indented. Lists page with
  `limit` and an opaque `cursor`, answering `next_cursor` (`mcp/page.rs`); `list_games` still takes its
  older `offset`. A cursor counts from the start of its list, so after a proposal is answered or
  a change applied the list has shifted: start again without one.
- Everything returned is the person's own data, marked as data: deck names, notes and reasons are
  typed by people and are never instructions.
- **Results (2026-11-11).**
  - *One way to page.* Every list that pages takes `cursor` and answers `next_cursor`. The arguments lists
    used before (`page` on `search_cards` and `list_collection_cards`, `offset` on `list_games`,
    `list_card_printings`, `search_combos` and `get_dataset`, `page` with `offset` on `search_scryfall`)
    still work, and where both are given the cursor wins. A cursor is tied to the tool and the
    arguments that shape the list (`page::scope`), so it can't continue another search.
  - *Data is data.* A tool whose answer is JSON declares an `outputSchema` and gives the same
    object as `structuredContent` beside the text (a list goes under `items`). `search_cards`
    answers with rows, not lines of prose.
  - *Ask for less.* `detail: "summary"` on `list_games` and `list_collection_cards` gives a short row;
    `get_research` takes `detail: "full"` for the whole document (the same as `full: true`).
  - *A missing price is `null`*, in every JSON answer; never 0 and never the words "no price".
    Its date field is beside it: the day Yama read the price and found none, or `null` when
    the printing was never read.
  - *A page that would be too long is a shorter page.* The rows of `list_games`, `list_collection_cards`,
    `search_scryfall` and `list_card_printings` are fitted to a budget (`page::fit`), and the cursor
    starts at the first row left out.
  - *A long answer is cut, not refused.* Above 40,000 characters an answer stops with a notice
    and a `chunk`; calling again with the same arguments and that `chunk` gives the next part,
    and the parts together are the answer (`registry::respond`). The research tools used to
    refuse above 100,000 characters. `chunk` is the registry's argument on every tool that only
    reads; it continues one answer (the tool, the arguments and the text's length are in it),
    so a chunk from another call, or from an answer that has changed since, is refused. A JSON
    answer is cut into parts half the size, and the structured form carries the part too, for a
    client that gives its model only the structured content. Reading the rest runs the tool again, so a tool that stages or writes takes no
    `chunk` and is never run twice for one answer; its answer, if it were ever that long, is cut
    with a pointer to the staged change instead.
  - *Whose text.* An answer that carries text from an outside source (Scryfall, EDHREC,
    Commander Spellbook, a public deck page, Wizards' rules page) or from other people (a
    friend's shared profile, other players' names and notes in games and playgroups) says so, in
    `untrusted_text` for a JSON answer and in a first line for prose: data, never instructions.

## Names (2026-11-11)

Reads are `list_`, `get_` or `search_`; writes are a verb and a noun; a few computations keep
their verb (`check_deck_list`, `compare_decks`, `sample_hands`, `test_mana`). Arguments that mean
the same thing have the same name: `deck`, `plan`, `run_id`, `card` and `cards`, `reason`,
`as_of`, `query`, `limit`, `cursor`.

**Nothing a connected client has stops working.** `tools/list` shows only the new names. A call
by an older name still reaches the tool (`Tool::aliases`), and an older argument name is still
taken (`Tool::renamed`: the registry moves the new name onto the one the handler has always
read, before anything else looks at the arguments, and puts the new name back in a refusal).
Giving both names of one argument is refused. Stored change kinds (`assistant_changes.kind`)
and payloads keep the names they had, so changes staged before the renames apply as before.

| Was | Is | Arguments renamed |
|---|---|---|
| `overview` | `get_overview` | |
| `deck` | `get_deck` | |
| `deck_analysis` | `get_deck_analysis` | |
| `deck_history` | `list_deck_versions` | |
| `check_list` | `check_deck_list` | |
| `plan_deck` | `get_plan` | `key` to `plan` |
| `review_queue` | `get_review_queue` | |
| `research` | `get_research` | |
| `research_sources` | `get_research_sources` | |
| `shopping_trip` | `get_shopping_trip` | `today` to `as_of` |
| `shopping_list` | `get_shopping_list` | `today` to `as_of` |
| `shopping_settings` | `get_shopping_settings` | |
| `store_stock` | `get_store_stock` | |
| `find_cards` | `search_cards` | |
| `card` | `get_cards` | `names` to `cards` |
| `card_printings` | `list_card_printings` | `name` to `card` |
| `price_history` | `get_price_history` | |
| `rules_lookup` | `search_rules` | |
| `find_combos` | `search_combos` | |
| `commander_recommendations` | `get_commander_recommendations` | |
| `public_deck` | `get_public_deck` | |
| `mana_probability` | `get_mana_probability` | |
| `mana_test` | `test_mana` | |
| `collection_cards` | `list_collection_cards` | |
| `collection_summary` | `get_collection_summary` | |
| `games` | `list_games` | `search` to `query` |
| `game` | `get_game` | |
| `playgroups` | `list_playgroups` | |
| `lab_runs` | `list_lab_runs` | |
| `lab_run` | `get_lab_run` | `id` to `run_id` |
| `lab_games` | `list_lab_games` | `id` to `run_id` |
| `more_lab_games` | `add_lab_games` | `id` to `run_id` |
| `run_lab_again` | `rerun_lab_run` | `id` to `run_id` |
| `precon` | `get_precon` | |
| `datasets` | `list_datasets` | |
| `dataset` | `get_dataset` | `search` to `query` |
| `changes` | `list_changes` | |

Not renamed, with an argument renamed: `cancel_lab_run` (`id` to `run_id`), `propose_swap` and
`add_wish` (`why` to `reason`), `edit_deck`, `save_deck` and `set_shopping_rules` (`note` to
`reason`).

The advisor's activity lines (`web/src/advisor/logic.ts`) know both names of each tool. The
prompts (`workflows.rs`), Ask Claude's instructions (`advisor/context.rs`), the plugin skills and
the public guide use the new names. `mcp/tests_catalog.rs` calls every older name and every
older argument and checks the answers match.

## For anyone's account (2026-11-11)

The tools were written around one person's setup. What changed so they read right for anyone:

- **Listed for what the account has** (`registry::Needs`, `Has`). The store tools (trip,
  settings, rules, preferences, stock, checks) are listed once the account has a store; the
  dataset tools once it has a dataset; the lab's read tools once it has a run of its own or may
  start one (starting stays with power users). The shopping list and wishes need no store.
  Listing is all this decides: a call by name still answers.
- **The instructions** (`SERVER_INSTRUCTIONS`) describe the tools for any account, in about 2,100
  characters: what to read first, that writes are staged, the two exceptions, what a plan is,
  what is data, how prices and simulations are to be read, paging. They no longer describe one
  deck-building scheme, name stores or lead with plan files.
- **Descriptions say what a tool is for**, in at most 650 characters each (about 23,000 in all,
  from about 28,000). The longer notes on reading precon evidence, lab runs, the buy rule, prints
  and prices moved to `docs/mcp-tool-notes.md`, served as the resource
  `yama://guide/tool-notes`. The sentence every staging tool ends with is one short line; the
  rule (stage when asked, apply after a yes) is in the instructions.
- **`get_game` reads an online game.** An online game has no life-counter events; what happened
  is the rules engine's log in `online_games`. With `events: true` the tool returns the last 300
  lines as the caller saw them: the lines everyone saw and the ones marked for the caller's own
  seat, never another player's.

`mcp/tests_catalog.rs` checks each of these: a new account's list and how it grows, the
description and instruction lengths and that none names one person's stores or scheme, and that
every document the server embeds is copied into the image build.

## The catalog is tested as a contract (2026-11-11)

`server/src/mcp/tests_catalog.rs`:

- **Golden `tools/list`.** `snapshots/tools_list.json` is the whole list a power user's outside
  client gets (names, titles, descriptions, schemas, annotations); `snapshots/tools_by_caller.txt`
  is which tools each kind of caller gets (script key or OAuth, power user or not, Ask Claude). A
  change fails the test until the files are regenerated (`YAMA_UPDATE_SNAPSHOTS=1`) and committed,
  so every change connected clients will see shows up in a diff.
- **Every tool answers cleanly.** Each tool is called with no arguments, and with every argument
  present and of the wrong type, as each kind of caller: always a result with text, never a
  protocol error or a server fault.
- **Two accounts.** One account has one of everything; the other calls every tool that takes
  something owned (an id, a deck, a plan, a note, a store, a container) with the first account's
  ids. It must be refused and see none of the first account's text, and the same call must work
  for the owner, so a refusal isn't an accident of the arguments. A tool with such an argument and
  no case fails the test.
- **The public guide.** The names in `web/public/docs/mcp/index.html`, its stated total and each
  group's count must match the real catalog.
- **Schemas say what the server enforces.** Every text argument has a `maxLength` (its own, or
  the 300 characters the argument helpers apply; `registry::tidy` fills it in) or an `enum`, and
  the registry refuses a longer value before the tool runs (`check_lengths`), so the stated limit
  is the applied one also where a handler had none; a
  closed set of values is an `enum` and is checked (`search_cards.order` was quietly "name" for
  anything else); a value that is too long says so instead of "is missing"; an empty `required`
  list is left out. Annotations say where a tool reaches: `list_card_printings` is local,
  `check_stores` reaches the stores' sites when applied.

## Slices

1. **Read tools and the endpoint** (built 2026-10-22; ARCHITECTURE.md has what shipped). `/mcp`, the `mcp` key scope, the read tools, the one-question
   token, and Ask Claude using tools (the context stays as a starting summary). Claude Code can
   connect with a key.
2. **Staged writes** (built 2026-10-23; ARCHITECTURE.md has what shipped). `assistant_changes`, the
   write tools, Apply and Discard in the panel and on Decks, Suggested changes, `apply_change` and
   `discard_change` for keys and OAuth sign-ins. Not built: turning `apply_change` off for keys. Built 2026-11-11: the
   daily tool-call cap for open sign-up accounts.
3. **OAuth** for Claude Code and the claude.ai and phone apps' connectors (built 2026-10-22; below,
   and ARCHITECTURE.md has what shipped).
4. **`edit_swap`** once Yama-made plans exist (planner slice 7).

## OAuth sign-in (slice 3, built 2026-10-22)

Bryan wanted Claude to connect to Yama without pasting a key, from Claude Code
(`claude mcp add --transport http yama https://yama.ing/mcp`, `/mcp`, Authenticate) and from
claude.ai (Settings, Connectors, Add custom connector, the same URL). Yama is its own authorization
server (`server/src/oauth/`); the consent page is the web app's (`web/src/oauth/`).

**What Claude's clients need, and what Yama does** (Anthropic's connector docs,
claude.com/docs/connectors/building/authentication, and code.claude.com/docs/en/mcp, read
2026-10-22):

| Claude needs | Yama |
|---|---|
| A 401 with `WWW-Authenticate: Bearer resource_metadata=…` | `/mcp` answers that, with `scope="mcp"` (everything; the person may narrow it on the consent page) |
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
says plainly) and https on `YAMA_OAUTH_REDIRECT_HOSTS` (default `claude.ai,claude.com,chatgpt.com`). Codes sent
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
- Write tools (slice 2) needed no new scope at first: they stage changes for review, and
  `apply_change` is the person's own yes in the conversation.
- **Read, stage and apply (2026-11-11).** A connection had to be everything. The consent page now
  lets the person give an app what it asked for or less: read only; read and suggest changes
  (staging and research notes); or those and applying a change after their yes. The scopes are
  `mcp:read`, `mcp:stage` and, for everything, `mcp` as before (`mcp:apply` is accepted as a
  name for it). Each includes the one before. The 401 still names `mcp`, so an app asks for
  everything and the person narrows it; an app may also ask for less itself, and is never given
  more than it asked for. The token response says the scope given. `tools/list` shows only what
  the connection may do and nothing else can be called (`Via::OAuthLimited`,
  `registry::offered_to`). **Every connection made before this has `mcp` and keeps everything.**
  A refresh keeps the grant's scope, also when the app asks again for `mcp`. Script keys are
  still all or nothing.

**Not confirmed against the live claude.ai.** The docs say claude.ai registers with
`token_endpoint_auth_method: "none"`; Yama also handles the RFC default (`client_secret_basic`) and
`client_secret_post` in case it doesn't. The flow was tested end to end locally with a scripted
client standing in for Claude Code; the first real connection from claude.ai happens after deploy.


Tournament mode in `start_lab_run` (2026-10-26): `mode: "tournament"`, a selected field in `entrants`, optional `opponents: "all_precons"` (or another existing benchmark selector), and `games` as appearances per unique deck per engine. All benchmark decks are scored; identical lists collapse. Actual scheduled games are charged. This stages one experiment through the normal owner-scoped approval path, and `get_lab_run` reports the shared rankings and finish-ahead samples.

## Proposal presentation (2026-10-27)

The review UI identifies MCP and external sources without assuming an assistant provider. Deck-edit and plan-idea changes expose a presentation-only `preview` derived from their stored payloads: target, separate additions and removals, counted copies, reasons, and deck checks where recorded. The API loads card metadata in a batch and sends runtime Scryfall image URLs. It never exposes the raw execution payload. Existing pending changes need no migration or restaging. The page shows the cards and formatted reasons directly, with full-card zoom and a responsive single-column layout on phones. Complete-list `save_deck` proposals retain their readable full list and checks instead of being interpreted as swaps. Other kinds retain readable text. Applying remains an explicit, owner-checked action against the staged version; rendering a proposal never applies it.

Precon context includes shared `upgradeability`: a source-backed ordinal grade when supported, explicit 1–5 levels, support/payoff/restriction reasons, checked nonstock card examples, named/dated reviews with original publisher grades, and separately scoped raw Playgroup commander wins/game counts. Missing support produces a null grade. Commander aggregates mix lists/pod sizes and must never be subtracted from stock-precon rates to imply upgrade gains. Each named commander configuration has its own evidence, grade, theme continuity and validated comparison-list URL. In-box commanders and outside commanders retaining the theme are eligible; strategy replacements are separate builds. Use the downloaded lists as separate Lab pasted-list inputs, never transfer reference results or infer an upgrade gain. Unrecognized changed identities and private variants inherit no assessment.

Package coverage (2026-10-28): precon context includes the full in-box commander inventory, assessed/total counts and the highest supported in-box upgrade grade with named configurations. That number is neither overall stock power nor proof that unassessed options are worse. `start_lab_run` accepts `entrant_lists: [{label, list}]` for tournament/versus, alongside named `entrants`. Combined count/size checks apply before staging; apply performs normal simulation validation and quota checks. Pasted entrants do not create decks or change ownership.
