# Critique of the planner design (2026-10-18)

Found by a completeness critic against the real code. Implementers must address the high items in the slice they touch.

## [high] Installed status already has a home in commander-decks, and the design ignores it. data/upgrades.json has 239 rows with status planned/ordered/installed/skipped and stable ids (upgrade-NNN); check_project.py checks that enum. README lines 58 and 81 and the docstrings of library.py and compare_lists.py all say installation is tracked there, and notes/todo.md says 'Install the bought cards ... then mark swaps installed'. The design adds a second install record (Yama ticks pulled into data/planner/installed.json) and never mentions upgrades.json. upgrades.json is also out of step with swaps.json: Fantastic Four still has the old 24-swap package, and the deck is named 'The Fantastic Four'.

**Fix:** Add an open question for Bryan. Option (a): pull.py writes ticks into upgrades.json as status 'installed', matched on deck, add and cut, and reports rows it can't match (Fantastic Four). Option (b): upgrades.json stops being the install record, with his OK; then update README lines 58/81, the library.py and compare_lists.py docstrings, check_project.py and todo.md in the same change. Either way, export the upgrades.json statuses (including 'skipped') so Yama starts from the repo's state, and the rest of the design no longer claims swaps have no stable ids.

## [high] Unknown card names never get resolved later. The import stores NULL oracle_ids, and re-uploading the same content writes nothing. So when Scryfall adds the Star Trek cards (around 2026-11-13), the stored rows stay unresolved, which keeps blocking 'Make this a Yama deck' and lab jobs. That lasts until some unrelated plan change, or a forced import. If oracle_ids are part of the state content_hash, resolving them later also creates new 'lists' with the same 100 names.

**Fix:** Resolve names when the bundle is built, or re-resolve the unresolved names after each card import, instead of fixing them at import time. Hash states on (name, qty, board) only and keep oracle_id and printing out of the identity hash. Add a test: import with an unknown name, add the card, and the bundle now resolves it with no re-import.

## [high] The bundle's cache key misses the daily price and card imports. GET /api/plan/bundle?rev=N returns {unchanged:true} whenever revision matches, but revision goes up only on imports and inputs. YAMA_AUTO_IMPORT adds price_snapshots every day, so the phone keeps showing old market prices and over-market flags with no warning.

**Fix:** Key the cache on revision plus the latest price date (and the latest card import run), as an ETag or as part of rev. Show prices_as_of on the Buy page.

## [high] The local test plan would break the other Yama worktrees, or test against an empty database. yama-planner's data/ is gitignored and empty (no card data, so every name is unknown). The populated DB is ~/Developer/yama/data/yama.db: 36,509 cards, prices to 2026-10-18, bryan@example.com and the two 'commander-decks' decks. Running the planner binary against that file applies 0006. sqlx then refuses to start the main and lab servers (VersionMissing: 6 is applied but not in their migrations). Two servers also both want ports 8787 and 5173.

**Fix:** For slice 1, run against a copy: `yama-server backup yama-planner/data/yama.db` (or cp with the WAL checkpointed) into the planner worktree. Use a different YAMA_BIND port and Vite port. For a more realistic test (existing decks, real account), use deploy/pull-db.sh into the planner worktree's data/ and sign in by dev login as bryanroscoe@gmail.com. Spell this out in slice 1's 'done when'.

## [high] 'commander-decks work is on its own branch' doesn't fit a checkout that several threads share. Switching branches in /Users/bryanroscoe/Developer/commander-decks would disrupt the other threads (one has uncommitted .gitignore, scripts/sim and data/sim work right now). build.sh also has side effects outside the repo: version.py bumps data/shopping/guide-version.json on the branch, which will conflict with main's bumps, compare_lists.py --downloads overwrites ~/Downloads/mtg-deck-lists, and Chrome re-renders the PDFs.

**Fix:** Use `git worktree add ../commander-decks-planner -b planner`. In slice 2, test `python3 -I scripts/planner/export.py` on its own. Add the build.sh line only at merge, and never run build.sh with --downloads from the branch. Say this in the slice 2 instructions.

## [high] The Tricky Terrain fields the design depends on never reach the exporter. swapdata.tricky_rows() builds new dicts with a fixed set of fields, so the new `was` and `from_candidate` fields on tricky-terrain.json rows are dropped, and so are game_changer, type and the dated per-swap market `price` (checked_on 2026-10-09, price_note). The design only rescues `band`.

**Fix:** Have the exporter join tricky-terrain.json rows by position or by (inn, out) for band, game_changer, was and from_candidate, and turn each `price` into a market_benchmark quote dated T.checked_on with price_note as its source. Or make tricky_rows() pass those fields through, which is a small edit to a shared file. Add a test that a Tricky Terrain rename alias survives.

## [high] publish.py's 'must be committed' input list misses files that library.build() and the self-checks read: data/collection/mythic-tools-export-*.csv (the newest scan sets every slot's printing), precon-lists-*.json (the stock lists come from these, not precons.json), card-info-*.json, data/shopping/imgmap.json and decks/imports/*.txt (review server build_data() reads them in the self-check), and notes/todo.md (which the mapping parses for open questions). A new uncommitted Mythic export would change plan_states and still pass the dirty check.

**Fix:** Add those paths to the list in 6.1. Move the open questions out of todo.md into a structured, hand-kept data/planner/notes.json (deck, kind, text) and list it as an input. Parsing markdown is fragile.

## [high] The interim 180-print check counts rows only, and the record it relies on gets rewritten. printlist.py rewrites docs/shopping/mtg-print-order.txt on every build, so the 'proper fix' (take the 180 lines from that file) stops working as soon as any print row changes. A one-for-one print swap keeps the count at 180 and quietly labels the new card as already on the placed order. (Today the file sums to 180 and hasn't changed since 0c4dfbf.)

**Fix:** Freeze the placed order now as data/planner/mpc-order-placed-2026-10-15.txt, from the current file or `git show 0c4dfbf:docs/shopping/mtg-print-order.txt`. The exporter, and later purchases.json's proxy order, compare the multiset of PRINT `inn` names against that frozen list. Rows on the order are 'placed'; the rest are 'next order'. No count check.

## [high] The spares difference is a bug in the repo, not just a Yama correction. spares.py ignores whether a move is ready and ignores NOW_FILL. So docs/spares.md, which AGENTS.md says to check before buying or printing, lists Sepulchral Primordial as out now, although Karmic Guide only leaves Lorehold when the Ark of Hunger print arrives. It also says Mount Doom leaves 'when Volcanic Island is printed', but NOW_FILL takes it out now. A Multiverse Reforged proposal and decisions.md's 'Spares first' already count on Sepulchral Primordial.

**Fix:** In slice 2, rewrite spares.py to derive from library.build() (released sets, NOW_FILL, move readiness), so the guide and Yama agree. Flag the Sepulchral Primordial candidate as depending on the Karmic Guide question. Then remove spares from the 'deliberate differences' in slice 5.

## [high] What a stand-in's later_out means is undecided, and the design doesn't raise it. 19 of the 21 stand-ins have later_out, and the review site says 'then takes out X'. But library.build()'s after list and spares.py treat every stand-in as a spare once its print arrives. Two plans also claim the same cut: Prismari's stand-in Wisdom of Ages has later_out Faerie Mastermind, and the approved Scarlet Witch move also takes out Faerie Mastermind. The design only lists the stale Scarlet Witch later_out.

**Fix:** Add this to the open questions. Until Bryan answers, Yama shows a stand-in's later_out as 'suggested, not in the plan'. The exporter warns when two rows name the same later_out or move target in one deck.

## [medium] Several things Bryan uses today have no Yama equivalent, so 'Deploy 3 replaces the ~/Downloads guides' doesn't hold. Missing: the bought-cards A–Z list (for sorting a delivery) and an A–Z print list; printlist.py's 'Check Card Gurus first' list (its CG prices are hard-coded with no date) and the 'Don't print Karmic Guide' callout; the collection browser (where every card is: deck, spare, bulk box or print on order); the scan check, which deck-lab-plan's Overview counts as 'scanned cards to check'; and deck-lab-plan's Games page. All of these except the scan check work are pushed to slice 9 or dropped.

**Fix:** Export library.build()'s bought, scan match (scan_ok, scan_diff), extra and scancheck results in the document from slice 2, computed in Python, and render them read-only in slice 5. Add a 'Sort a delivery' A–Z view per order (real or proxy). Store Card Gurus checks as dated stock_check quotes, or leave them out; never carry undated prices. Otherwise narrow the Deploy 3 claim.

## [medium] Multiverse Reforged doesn't fit the single proposed build. proposalBuild takes every proposal not answered 'no', which mixes the core group, the Bracket 3 group and the Bracket 4 group. So it can't reproduce the hand-written EDHbots lists Bryan uses (multiverse-reforged-2-after-local-buys, -3-proposed-bracket-3). Multiverse Reforged's brackets also go up (adding Game Changers), while plan_decks.bracket only models bags that go down.

**Fix:** Give proposalBuild a group or bracket filter, using the candidate `group`, plus a 'local buys and spares only' option. Show Multiverse Reforged's bracket groups as cumulative additions.

## [medium] The lab can't run Bryan's proposed or bracket builds. plan_states allows proposal, bracket3 and bracket2, but nothing ever writes them for source='import', and the snapshot endpoint is limited to source='yama'. So imported plans can only sim stock, now and after.

**Fix:** Allow POST /api/plan/decks/{key}/states for derived states (proposal, bracket3, bracket2) on imported decks too. They are views, not plan content. Or export them from Python. Drop the enum values otherwise.

## [medium] The lab section duplicates the commander-decks sim tooling and contradicts itself. scripts/sim already has a 198-precon catalog that rewrites names to the engine's face names (precons.py), a paired-seed scheduler (schedule.py) and a Plackett-Luce analysis (analyze.py). The design rebuilds pairing in Rust, uses Wilson intervals, and in v1 uses only the user's own stock lists as opponents. It writes deck files from plan_states or deck_versions in Scryfall names (full 'A // B' names) that the runner won't load. Section 11 mounts /mnt/user/appdata/yama/data/lab/jobs/<id>, while 15#22 claims the appdata/yama-lab layout, and lab.sh start hard-mounts $DIR/decks and $DIR/runs. Approving on the phone also does nothing until someone runs lab.sh on the Mac.

**Fix:** Agree with the lab thread on one scheduler and one analysis. Rewrite names through phase's CardDatabase, which the server has via PlayHub's card data, or port precons.py's rules. Take opponents from the shared precon catalog. Copy results back to data/sim/runs/<run> for analyze.py. Settle on one directory layout. Add an open question about a polling worker container.

## [medium] Planned sharing would leak prices and stores through text fields. Slot `source` strings ('Bought at Pat's, ordered 2026-10-08, $0.50'), the state log, and plan_swaps listing, note and got sentences all contain store names, order dates and prices paid. Slice 10 promises never to show those, but it only hides tables.

**Fix:** Store structured references (order_item_id, got) and build the sentences on the client. The shared view leaves out source, listing, note and the log, and a test checks that no '$' or store name appears in a shared payload.

## [medium] 'Start from the house rules' copies Bryan's current rule set for other users. That reads his private settings row on their behalf, which contradicts the owner-only rule.

**Fix:** Ship the template as a versioned constant in packages/core (Bryan's rules with nothing personal), and never read another user's plan_settings.

## [medium] Export and import don't round-trip for Yama-made plans. Importing any yama-plan/1 document creates source='import' decks, which are read-only (409). So restoring a friend's backup makes their plan uneditable. The server also can't write `states` for Yama-made plans, because states.ts runs only on the device.

**Fix:** Use the meta.app value (yama vs commander-decks) to keep source='yama' on restore, and make `states` optional for Yama-made documents. Extend the slice 6 test to edit the plan after the round-trip.

## [medium] Slice 6 lets Bryan add Yama-made rule sets next to the imported ones. rulesAt() picks the newest date, so Yama's flags would drift from the rules agents apply in the repo. The import also silently replaces a Yama-made row with the same date. Both break Decision 2.

**Fix:** For owners with imported decks, settings are managed by the export (409 on change). Or keep separate rule sets per origin, with the imported set winning for imported decks.

## [medium] Imported lists aren't checked for legality or color identity. AGENTS.md requires rechecking color identity and current legality after deck edits, which the repo's checker can't do (check_project says so). Yama can, with decks::validate, but the design only checks 100 cards and singleton. Yama's cards table also has no game_changer column, so friends' bracket views (slice 7) have no Game Changer data, and the exported Game Changer list (brackets.json, checked 2026-10-09) isn't shown with its date.

**Fix:** Run decks::validate on the resolved states during import and put the results in the report and the deck warnings. This would flag an off-color card such as Mount Doom in the stock-plus-owner list. Plan a later migration that adds Scryfall's game_changer to the card import (a change to an existing table, so note it against Decision 18). Show the Game Changer list's checked_on date.

## [medium] check_project.py gets two warnings, but the new hand-edited files get no invariants. Agents will edit data/planner/stores.json, settings.json, inbox-resolutions.json and the `was`/`from_candidate` fields on swaps.json rows, and nothing checks them. The export is non-fatal in build.sh, so a broken export can go unnoticed for weeks. deck-lab-plan's P1 wanted check_project to check the bundle against the guides. plan.json is gitignored, so it is missing in a fresh worktree.

**Fix:** Add asserts: no `was` key equals a live key; no `from_candidate` id is still in candidates.json; settings dates are unique and sorted; stores have unique keys and https templates containing {items}; every resolution op_id appears in a data/planner/inbox file. Warn, rather than fail, when plan.json is missing or older than guide-version.json.

## [medium] pull.py's port-8765 guard never clears after Deploy 2. The review site stays runnable in read-only mode on 8765, so 'port is listening' doesn't mean 'accepting answers', and pull.py would refuse every time. The proposed AGENTS.md text also leaves the 'Proposals go through the review site' section, and the matching README text, telling agents Bryan answers in server.py.

**Fix:** server.py serves /api/status {read_only}, and pull.py refuses only when read_only is false. Slice 4 rewrites that AGENTS.md section, the README and deck-lab-plan to point to Yama's Review page, and says what to do when pull.py can't reach Yama: don't promote from a stale review.json.

## [medium] Uploads hash raw bytes, but the web client may re-serialize the file. If it uses api(..., {json}), the bytes change: Python writes 124.0, JS writes 124. Then a browser upload and a publish.py upload of the same file get different hashes, and the dry run and head compare stop matching. Axum's Json extractor also returns 415 or 422, not the 400-with-JSON-path the design promises.

**Fix:** Upload the File untouched (body: file, Content-Type application/json). Read Bytes in the handler and parse the envelope with serde_json::from_slice into RawValue yourself. Document 'hash = exact bytes of plan' in docs/plan-format.md, together with the rule that new fields are optional and unknown fields are ignored within yama-plan/1.

## [medium] useLogout can leave plan data on the phone. It returns early for Cloudflare Access sign-out, and it awaits the network logout before clearing anything, which throws when offline. Plan data added to its cleanup would survive those paths, and the plan data includes prices paid.

**Fix:** Clear the plan:<user_id> IndexedDB entry and the outbox first, before the api('/api/auth/logout') call and before the cf_access branch, and don't let a failed request skip it.

## [low] data/shopping/plan.json already exists (legacy plan rows used by why.py, parse.py and swaps.py), so data/planner/plan.json invites mix-ups between agents. The gitignore reason ('contains prices paid') also doesn't hold, because purchases.json, with prices, is committed.

**Fix:** Name it data/planner/yama-plan.json, and give the reason for ignoring it as 'derived output'.

## [low] Some schema and code details don't line up. candidates.json stores the Shopify `variant` as a JSON number (42427719221416), but plan_quotes.variant is TEXT. The 'yama_pat_<base64url>' token format needs a base64 crate Yama doesn't have. create_deck_with_cards hard-codes the version note 'created', and insert_version is private.

**Fix:** Stringify variant in the exporter. Build tokens from util::random_token() (hex). Add an optional note parameter to create_deck_with_cards for 'Make this a Yama deck'.

## [low] The import's 'retire what's not in the document' step needs NOT IN over a variable-length key list. Building placeholders at runtime would need AssertSqlSafe, and the design only promises static SQL for the bundle.

**Fix:** Use `NOT IN (SELECT value FROM json_each(?))` with a bound JSON array in import.rs too, and say so in 6.5.

## [low] The 'cheapest non-foil' market price takes each printing's own latest snapshot, so a printing that hasn't had a price for months can win and be shown as today's market.

**Fix:** Only use printings priced on the latest import date (or within a few days), and show the date of the price actually used.

## [low] The guide version doesn't identify the plan content. Changes that touch only plan.json (was, from_candidate, inbox resolutions, notes) don't change the guides, so two different plans can both show 'guide v6' in the banner. Separately, renaming a deck changes every key that contains its name, and per-row `was` can't cover that.

**Fix:** Show a short plan content hash next to the guide version. Add a deck-level `was` (old display names) that becomes key aliases.

## [low] The UI rules point at today's styles.css, but a design session is producing a new token spec. Per Bryan's memory notes it will go to ~/Developer/yama/design/tokens.md, with a planner brief in planner-brief.md; neither exists yet. styles.css still uses the felt tokens Bryan said he doesn't like.

**Fix:** In slice 3, use only token variables, write the planner brief for the design agent, and don't make style decisions that would need redoing once its spec lands.
