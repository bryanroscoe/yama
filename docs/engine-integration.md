# Embedding phase-rs in Yama

Status: research spike, 2026-10-18. Pinned target: phase **v0.113.0** (tag commit `0571ee32f08c`, released 2026-10-18). All file references are into that tag of <https://github.com/phase-rs/phase>.

## Recovery baseline, 25 October 2026

The accepted recovery baseline was Phase `9b2073b0986fe580d495fce2fa58b5762e24e3eb`.
Bryan approved a test-only assertion correction and fresh Codex final review in
lieu of the rate-limited Opus review. The six regressions and full Phase library
suite pass (24,452 passed, zero failed, eight ignored). The exact-head review
reports zero findings, Completion PASS and Maintainer-Simulation PASS. Local
validation is complete.
The final checkpoint changes only test assertions, so runtime/replay identity
remains `phase-v0.113.0+a3bc47c9-yama/cards-1e5608e6`. That baseline's production source was byte-identical to the measured `a3bc47c` candidate.
Current releases use the separate full commit pin described below.
The engine now lives in the private [Yama Phase repository](https://github.com/bryanroscoe/yama-phase).
Clone that repository beside Yama as `../yama-phase`, then check out the full SHA in
`deploy/phase-rev`. `deploy/phase-repo` records the source; release checks fetch it and require
the pin to be published on its `main` or on a published `archive/*` tag (where a rebase of
main keeps the previous line) before exporting the engine. `YAMA_PHASE_DIR` can select
another checkout for release exports. The old patch files are retired; the initial fork preserves
their complete source and upstream history. The [recovery report](engine-recovery-2026-10-25.md)
remains historical validation evidence, not a claim that every current game succeeds.

The new local export is `card-data-1e5608e61683de41.json` (101,470,976 bytes),
SHA-256 `1e5608e61683de41c84f08f70115bef38db13df85bc5e01fd0eb249cf023244d`.
It passes the pinned engine's schema and export-integrity checks. Two generations
produce identical card exports and name lists.

The archived MTGJSON inputs are unchanged from the historical export below.
Extract `data/engine/card-data-2905717cc9fe0f53-inputs.tar.zst` into a temporary
directory and use its `data` directory as `INPUT_DATA`. From the pinned Phase
checkout, build the tools and generate without rewriting tracked token/subtype
sources:

```sh
CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 cargo +stable build -p phase-engine \
  --features cli --bin oracle-gen --bin card-data-validate
RUST_MIN_STACK=33554432 GATED_SETS_AS_OF=2026-10-25 \
  ./target/debug/oracle-gen "$INPUT_DATA" --stats \
  --names-out card-names.json --output card-data.json
./target/debug/card-data-validate card-data.json
shasum -a 256 card-data.json
```

Name the output with the first 16 hexadecimal characters of that hash. Preserve
the earlier export for older games; a matching engine and card-data pair is
required for replay. A future deployment must copy and verify the new export and
update any explicit `YAMA_ENGINE_CARD_DATA` override as well as the checked-in
default. Release authorization and fresh-main checks still apply.

The remaining sections preserve the original research and earlier export's
provenance; their historical test and deployment observations are not claims
about the current recovery candidate.

Labels used below:

- **[ran]**: verified by running something on this machine.
- **[read]**: read in the source, not executed.
- **[inferred]**: my conclusion from reading, not checked.

## Summary

- The engine API is a pure reducer with exactly the hooks Yama needs: new state from a seed, `apply(state, actor, action)`, legal actions per viewer, a per-viewer filtered state, an AI chooser, and a replay log with a player for it. Commander (command zone, tax, 21 commander damage, color identity, 2 to 6 players) is implemented and tested.
- **Blocker for a plain git dependency on stable Rust [ran]:** the phase workspace `Cargo.toml` begins with `cargo-features = ["codegen-backend"]`, and stable cargo 1.98.1 refuses to parse it. That applies to a path or git dependency too, because the crates inherit `version`/`license` from the workspace root. Deleting three lines fixes it (`cargo metadata` then resolves). This is the "Yama fork" commit. The code itself uses no `#![feature]`.
- **Card data:** the engine needs a `card-data.json` that matches the engine version. Phase hosts signed, content-addressed copies. The v0.113.0 file is 101 MB; I downloaded it and checked its SHA-256 **[ran]**.
- **The end-to-end demo did not finish.** The demo crate is written (`/tmp/phase-spike-demo/src/main.rs`). The build was stopped after about 28 minutes, still compiling the `engine` crate, because free disk fell below the 5 GB floor. The target dir was 3.4 GB at that point, 2.7 GB of it incremental cache. The game loop, replay round trip and per-seat views are therefore **unverified at runtime**. Section 5 gives the exact retry recipe.
- **Bryan's decks:** every card name in both 100-card lists is in phase's coverage data. Only Negative Zone Portal and Combat Celebrant are marked unsupported **[ran, against the 2026-10-17 coverage file]**.

## 1. Engine API surface

### Creating a game [read]

```rust
let db: Arc<CardDatabase> = Arc::new(CardDatabase::from_export(path)?);      // database/card_db.rs:117
let mut state = GameState::new(FormatConfig::commander(), 4, seed);          // seed: u64
let payload = resolve_deck_list(&db, &deck_list);                            // game/deck_loading.rs:290 (names -> faces)
load_and_hydrate_decks(&mut state, &payload, Some(&db));                     // deck_loading.rs:1314
state.all_card_names = db.card_names().into();                               // #[serde(skip)]; "name a card" choices stall without it
engine::game::install_card_db(&mut state, Arc::clone(&db));                  // game/printed_cards.rs:1611
engine::game::engine::start_game(&mut state);                                // game/engine.rs:19006, d20 contest from the seeded RNG
```

- `engine::game::replay::reconstruct_initial_state(&ReplayHeader, Some(&db))` (game/replay.rs:73) does exactly this sequence from a replay header. Yama should build live games through the same code so replays can't drift.
  - Catch: it also sets `state.debug_mode = true`. Server games must reject `GameAction::Debug(_)` at the transport. server-core forces `debug_mode = false` for multiplayer (server-core/src/session.rs:1087).
- `FormatConfig::commander()` (types/format.rs:2983): 40 life, 2 to 6 players, exactly 100 cards, singleton, command zone, 21 commander damage, `allow_debug_actions: false`.
- `DeckList` (deck_loading.rs:155) is name-based and positional:
  - `player` is seat 0, `opponent` is seat 1, `ai_decks[..]` are seats 2 and up.
  - Each `PlayerDeckList` has `main_deck: Vec<String>` (one entry per copy) and `commander: Vec<String>`.
  - Unknown names are **silently dropped** (deck_loading.rs:242), so Yama must compare resolved counts with the list.
- Deck legality is **not** checked by `GameState::new`. The game-creation gate is `deck_validation::validate_name_deck_for_format_full` (deck_validation.rs:549), which phase-server and engine-wasm call. Yama must call it too.

### Actions and validation [read]

- `apply(state, actor, action) -> Result<ActionResult, EngineError>` (game/engine.rs:923). The engine rejects any `actor` that isn't the authorized submitter. `actor` must come from the authenticated socket, never from the payload.
  - `ActionResult` carries `events` and `log_entries`.
- `apply_with_rejection` (:934) returns a client-safe `ActionRejection`, already filtered for the viewer. Use this for human submissions.
- `apply_interaction(state, actor, semantic_owner, action)` (:1057) is the turn-control-aware form (Mindslaver and similar), used by the AI driver.
- Legal actions:
  - `ai_support::legal_actions(state)` (ai_support/mod.rs:2250) returns a flat list without mana abilities.
  - `legal_actions_full` (:2406) and `legal_actions_for_viewer(state, seat)` (:2608) return `(actions, spell_costs, actions_by_object)`. The per-object map includes mana abilities for the board UI.
- `state.waiting_for` (`WaitingFor` enum) says who must act and what kind of decision it is. `GameOver { winner }` is terminal. Mulligans are simultaneous decisions: `acting_players()` can return several seats.

### Per-player view (hidden information) [read]

- `engine::game::filter_state_for_viewer(&state, seat)` (game/visibility.rs:1302) returns a redacted `GameState`.
- `filter_state_for_unseated_viewer` (:1309) is for spectators.
- `filter_events_for_viewer` handles events.
- phase-server's per-seat payload is the model to copy: `build_state_update_message` (crates/phase-server/src/main.rs:698). It sends:
  - the filtered state
  - filtered events
  - legal actions for that seat
  - `spell_costs` and `legal_actions_by_object`, only to the acting seat
  - `derive_transport_views` (`derived_views::derive_views`, derived_views.rs:1487)
  - `interaction::derive_viewer_interaction`
- Note: that function forwards `log_entries` unfiltered. Entries carry `LogVisibility::HiddenInformation` (types/log.rs). Check whether phase filters these elsewhere before trusting the log on the wire **[inferred risk]**.

### AI [read]

- One decision: `phase_ai::search::choose_action_with_session(&state, seat, &AiConfig, &mut rng, &Arc<AiSession>) -> Option<GameAction>` (phase-ai/src/search.rs:263).
- Choose and apply one action through the correct seam: `phase_ai::auto_play::run_ai_action(...)` (auto_play.rs:250).
  - It routes stack-continuation passes through `apply_verified_ai_priority_pass`, which replays must record as a distinct kind (section 3).
- Batch until a human must act: `run_ai_actions` (:190). Headless all-AI: `run_driver_loop` (:559).
- Config: `phase_ai::config::create_config_for_players(AiDifficulty::{VeryEasy..VeryHard, CEDH}, Platform::Native, 4)`.
  - By default search is cut off by a wall-clock deadline (about 1.5 s), so choices aren't reproducible. That doesn't matter for replays, which record actions.
  - `.into_measurement(seed)` removes the deadline for reproducible soak tests (crates/phase-ai/src/bin/ai_commander.rs:1146).
- Per-game cache: `AiSession::arc_from_game(&state)`.
- **Stack size:** deep search overflows the default thread stack. Phase runs games on a thread with a 32 MiB stack (ai_commander.rs `GAME_THREAD_STACK_SIZE`). Tokio's blocking pool defaults to 2 MiB, so AI calls need a dedicated large-stack thread or `Builder::thread_stack_size(32 << 20)`.
- Hidden information: `choose_action` receives the full state but resamples opponents' hidden zones when `determinization_samples > 0` (phase-ai/src/determinize.rs). Whether the easier tiers peek through heuristics was not audited **[inferred: probably not, but unverified]**.
- `crates/phase-ai/src/bin/ai-commander` is phase's own all-AI 4-player Commander runner. It's the template for Yama's soak tests.

### Send/Sync [inferred]

The demo has compile-time asserts that `GameState`, `CardDatabase` and `AiSession` are `Send + Sync`, but it never finished compiling.

What the code shows:

- `GameState` is built from `im` persistent collections, plain data and an `Arc<CardDatabase>` handle.
- The RNG is ChaCha stored in the state.
- phase-server keeps sessions in a tokio app (`phase-server/src/game_executor.rs`).
- `GameState::clone()` is O(log n) (structural sharing), which makes snapshots and AI simulation cheap.

So one game per tokio task should be fine, with the CPU-heavy calls (`apply`, AI) run off the async threads.

## 2. Card data

- **Format [read]:** `card-data.json` is phase's own export: parsed ability AST per face, keyed by lowercase name. It's loaded with `CardDatabase::from_export` / `from_export_reader`.
  - It's produced by the `oracle-gen` bin (`--features cli`) from MTGJSON `AtomicCards.json` (about 50 MB gzipped), MTGJSON token set files and `AllDeckFiles`.
  - The driver script is `scripts/gen-card-data.sh`. It needs bash, curl, jq and cargo, plus an optional Forge cardsfolder. It also rewrites tracked engine data (`crates/engine/data/known-tokens.toml`), so don't run it in a pinned fork.
- **Prebuilt download [ran]:** each phase release publishes a manifest, signed with minisign and checked in `phase-server/src/data_bootstrap.rs`:
  - The manifest lives at `https://data.phase-rs.dev/desktop/release-server-v<version>.json`.
  - v0.113.0 points to `https://data.phase-rs.dev/card-data-eb309108eb0df708.json`: 101,118,731 bytes, SHA-256 `eb309108eb0df708b6cb5b3c75858149a9fd2864ee0f4ef81195cc75af058b85` (matched).
  - Preview builds have per-fingerprint entries in `desktop/preview-server.json`.
  - The unversioned `https://data.phase-rs.dev/card-data.json` is stale (last modified 2026-04-20). Don't use it.
- **Version lock [read]:** card data is the parser's output, so it must match the engine commit.
  - Phase's compatibility key (`scripts/engine-fingerprint.sh`) hashes `crates/`, `Cargo.lock`, `rust-toolchain.toml`, the card-data SHA and the draft-pools SHA.
  - Yama should store the card-data SHA alongside the engine commit and fetch by hash at deploy time, not at build time.
  - Nothing is needed at compile time except files already in the repo (`crates/engine/data/*`, 6.1 MB, embedded through `build.rs`).
- **Yama's own build [ran 2026-10-25]:** the downloaded file comes from upstream's parser, so Yama's parser fixes (patches 0016-0030) reach games only through a file built at the pinned commit.
  - Generator, at `deploy/phase-rev` (3bbfea6): `cargo build --profile tool -p phase-engine --features cli --bin oracle-gen --bin card-data-validate`. Then `GATED_SETS_AS_OF=2026-10-25 oracle-gen <data> --stats --names-out card-names.json > card-data.json`, `card-data-validate card-data.json`, and name it `card-data-<first 16 hex of its SHA-256>.json`.
  - That is `scripts/gen-card-data.sh` without the steps that rewrite tracked files (`--write-subtypes`, the token catalog), so the generator is the engine Yama compiles.
  - Inputs: MTGJSON only, no Scryfall. Build 5.3.0+20261024: `AtomicCards.json`, `SetList.json`, `CardTypes.json` and `Meta.json`, plus 460 set files in `mtgjson/sets/`, and the fork's `data/bracket_lists.json`.
  - The 460 set files are the 341 token sets `fetch-token-sets.sh` takes and 119 more draft sets (`fetch-draft-sets.sh`). Upstream's deploy has the draft sets in its cache; without them, 7,225 cards lose rarities.
  - Output: `card-data-2905717cc9fe0f53.json`, 101,462,596 bytes, SHA-256 `2905717cc9fe0f53549f113f0991e998ccd969c56357f07deba5efcd0f1fc76a`. A second run gave the same bytes.
  - Kept on saget next to the old file, and on the Mac in `data/engine/` (gitignored): the file, `.json.zst` (7.6 MB, SHA-256 `e2a3c279…e031`), and the inputs as `card-data-2905717cc9fe0f53-inputs.tar.zst` (129 MB, SHA-256 `7a798b5b…97df`; MTGJSON keeps no old builds).
  - **Against `eb309108` (v0.113.0's file):** 35,844 entries unchanged, 80 changed, 127 added (new cards) and 1 removed (an Un-card).
  - A control run of v0.113.0's generator on the same inputs splits the 80. Parser: 28. MTGJSON drift: 52 (12 Oracle errata, none in Bryan's decks; Arena format legalities; printings metadata). None changed both ways.
  - The 28 parser changes are the cardfix cards plus 17 the same patterns reach (per-opponent attacking tokens, "on each opponent's turn", "exile all the cards from your hand/library", the triggering player paying). No card gained an unimplemented part or a warning.
  - Yama's coverage: Bryan's cards fully supported go from 731 to 738 (partial from 34 to 28); the precon catalog goes from 5,864 to 5,871; none got worse.
- **Switching to it:** the steps are in order.
  1. The file is already at `/mnt/user/appdata/yama/data/engine/` on saget (99:100).
  2. Point the server at it. Either set `YAMA_ENGINE_CARD_DATA=/data/engine/card-data-2905717cc9fe0f53.json` in saget's `yama.env`, or change the default in `server/src/config.rs`.
  3. Set `ENGINE_VERSION` in `play/src/lib.rs` to end in `/cards-2905717c`. Every game stores it, and a replay only reproduces under the same engine and card data.
  4. Change `CARD_FILE` in `deploy/lab.sh`, and the `eb309108` defaults in `soak.rs`, `determinism.rs` and the README.
  5. Deploy. Leave the old file in place for replays of earlier games.
  - **Fresh installs:** `data.phase-rs.dev` doesn't have this file. Proposal: a release asset on `bryanroscoe/yama` (tag `carddata-2905717c`, the `.json.zst` and the inputs bundle).
  - `first-time.sh` would set `CARD_DATA`/`SHA` to the values above. When the server copy fails the check, it would download, decompress, check and copy the file, with `gh release download carddata-2905717c -R bryanroscoe/yama -p "$CARD_DATA.zst"`, then `zstd -d`, `shasum -a 256 -c` and `scp`.
  - Fallback: rebuild from the inputs bundle with the generator above. The output is deterministic.
- **Mapping Yama decks [read]:**
  - `CardDatabase::get_face_by_oracle_id(&str)` (card_db.rs:264) uses `CardFace::scryfall_oracle_id` (MTGJSON's `identifiers.scryfallOracleId`, the same value as Scryfall's `oracle_id`).
  - Map each Yama `{oracle_id, name, qty, board}` entry by oracle_id first, falling back to `get_face_by_name`, then push `face.name` `qty` times into `PlayerDeckList`.
  - `board: commander` goes to `commander`, `main` goes to `main_deck`, and `side` is ignored for Commander.
  - `export_subset_json(&names)` (card_db.rs:221) can write a small card DB for tests.
- **Memory [inferred]:** the full DB is 101 MB of JSON. Expect several hundred MB resident once parsed, shared by all games through one `Arc`. Not measured.

## 3. Replays

`crates/engine/src/types/replay.rs` [read]:

- `REPLAY_FORMAT_VERSION = 3`. This is the schema version, not the engine version.
- `ReplayHeader`:
  - `format_config`
  - `match_config`
  - `player_count: u8`
  - `first_player: Option<u8>`. Only `Some(0)` and `Some(1)` are honored; anything else runs the seeded d20 contest.
  - `seed: u64`
  - `deck_data: Option<DeckList>`. This is **names**, so replays also depend on the card-data version.
- `RecordedAction`: `{seq: u32, actor: PlayerId, action: GameAction, kind}`. `kind` is `Submitted` (default) or `VerifiedAiPriorityPass { semantic_owner }`.
- `ReplayLog`: `{format_version, header, actions, resolve_all_boundaries}`. Push with `push_action`, `push_verified_ai_priority_pass` and `push_resolve_all_boundary`.
  - Record only after `apply` returned `Ok`.
  - engine-wasm's recorder (`crates/engine-wasm/src/lib.rs:2357-2371`) is the reference.
  - Debug actions invalidate a recording.

Playback (`crates/engine/src/game/replay.rs`) [read]:

- `ReplayPlayer::load(log, Some(&db))` rebuilds the initial state from the header.
- `seek(n)` re-applies actions from the nearest cached checkpoint (one every 20 actions).
  - It uses `apply` for `Submitted` and `apply_verified_ai_priority_pass` for the AI marker.
- A failed re-apply returns `ReplayError::Desync { index }`. That is the signal for engine drift.

**Engine-version caveat:** the log carries no engine or card-data identity, and phase's client replay export adds none either. Yama must store its own, e.g. `games.engine_version = "phase-v0.113.0+0571ee32/cards-eb309108"`.

- A replay from another engine version may desync or silently diverge.
- To view old replays, either keep the old server binary and card data, or store snapshots (below) so a viewer can show states without re-simulating.
- `games.seed` is SQLite `INTEGER` (i64). Store the u64 seed bit-cast to i64, or as TEXT.

**Snapshots [read]:**

- `PersistedGameState::capture(state)` is serde-serializable (types/game_state.rs:14423).
- Restore goes through `prepare_for_restore(DeferUntilRehydrated)` then `finalize_after_rehydration(|s| { … })`. Several `#[serde(skip)]` runtime fields must be reinstalled inside that closure: `all_card_names`, card-DB rehydration, `install_card_db`, and `deck_pools`. See server-core `GameSession::from_persisted` (session.rs:1478).
- **server-core re-seeds the RNG on restore** (session.rs:1513-1519), so a restored server game can no longer be reproduced from seed plus log.
- Yama should either skip the reseed (the decode path already restores the RNG word position: `rehydrate_rng`) or, simpler, restore live games by replaying the log, using snapshots only as a cache.

## 4. Build feasibility

| Item | Finding |
|---|---|
| Toolchain pin | `rust-toolchain.toml`: `nightly-2026-04-19` with `rustc-codegen-cranelift-preview` and wasm32. Only the workspace manifest needs nightly. `grep '#!\[feature'` over `crates/` finds nothing **[ran]**. |
| Stable blocker | `Cargo.toml:1` `cargo-features = ["codegen-backend"]`, plus `codegen-backend = "llvm"` at lines 80 and 106 (profiles `wasm-dev` and `tool`). Stable cargo errors with "the cargo feature `codegen-backend` requires a nightly version of Cargo" for a dependent crate **[ran]**. After deleting those 3 lines, `cargo metadata` for a crate depending on `phase-engine` + `phase-ai` succeeds **[ran]**. Compiling to completion on stable was **not** confirmed. |
| Dependency path | Git dependency on a Yama fork at a pinned rev: `engine = { git = "…/phase-fork", rev = "…", package = "phase-engine" }` and `phase-ai = { git = …, rev = … }`. Use phase's `Cargo.lock` versions for the shared dependencies (I copied it into the demo). |
| Heavy dependencies | engine: serde, nom 8, im, petgraph, rand/rand_chacha 0.9, smallvec, strum, toml, sha2. phase-ai adds mimalloc (a C build, native only) and tracing-subscriber. No OpenSSL, no protobuf. One `build.rs` (engine: TOML to JSON for an embedded 5.9 MB token catalog). |
| Crate size | `crates/engine` alone is huge: `game/engine.rs` is 27k lines, `types/game_state.rs` 48k, and the crate has about 3,000 files. It compiles as essentially one rustc job, so `CARGO_BUILD_JOBS` barely helps. rustc RSS was about 1.8 GB **[ran]**. |
| Build size and time | Clean `cargo build` of the demo (dev, `debug = 0`, deps at `opt-level = 2`, 4 jobs): **stopped at about 28 min, target 3.4 GB, engine still compiling** **[ran]**. Breakdown: `incremental/` 2.7 GB, `deps/` 653 MB, `build/` 23 MB. |
| Expected as a git dependency | Cargo does not do incremental builds for git (non-local) dependencies, so most of that 2.7 GB disappears. My estimate is about 1 to 1.5 GB of extra target for Yama **[inferred]**. Also set `CARGO_INCREMENTAL=0` or `[profile.dev] incremental = false` while disk is tight. |
| Runtime profile | The engine and AI need optimization to be usable. Yama's root `[profile.dev.package."*"] opt-level = 1` already covers git dependencies. Release builds need `panic = "unwind"` so a panicking game doesn't kill the server. Phase uses `server-release` for this: thin LTO, `opt-level = 2`. |

## 5. Demo status

`/tmp/phase-spike-demo` (kept; source only, about 15 KB) depends on `crates/engine` and `crates/phase-ai` by path. Its `src/main.rs`:

1. Statically asserts Send/Sync.
2. Loads the v0.113.0 card DB.
3. Maps both of Bryan's decks name → face → oracle_id → face and reports misses.
4. Builds a 4-seat Commander game (FF, Rohan, FF, Rohan) through `reconstruct_initial_state`.
5. Drives every seat with `choose_action_with_session` plus the correct `apply_interaction` / `apply_verified_ai_priority_pass` seam, recording a `ReplayLog`, for N turns.
6. Prints the essential log lines, life totals and commander damage.
7. For each seat, checks `filter_state_for_viewer` (opponents' hand names visible?) and `legal_actions_for_viewer`.
8. Serializes the replay log and a `PersistedGameState` snapshot, restores the snapshot, and replays the log with `ReplayPlayer`, comparing life totals and zone counts.

**What happened:**

- Dependency resolution worked after the manifest patch.
- phase-ai and the demo crate had started compiling (pipelined).
- The `engine` crate was still in codegen when I stopped the build at about 28 min, because free disk hit about 4 GB.
- No compile errors were seen, but the output was buffered, so the demo's type-correctness is **unknown**.

**To retry** (needs about 4 GB free). The clone and card data were deleted, so first: shallow-clone tag v0.113.0 to `/tmp/phase-spike`, delete the 3 `cargo-features`/`codegen-backend` lines from its root `Cargo.toml`, copy its `Cargo.lock` into the demo, and download the card data from section 2. Then:

```
CARGO_TARGET_DIR=/tmp/phase-spike-target CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 \
  cargo build --manifest-path /tmp/phase-spike-demo/Cargo.toml
/tmp/phase-spike-target/debug/phase-spike-demo /path/card-data.json 8 7 Easy
```

Run it on a thread with a large stack if it overflows: wrap `main`'s body in `std::thread::Builder::new().stack_size(32 << 20)`. Phase's own equivalent check is `cargo run --profile server-release -p phase-ai --bin ai-commander -- <dir with card-data.json + feeds/>`.

## 6. Commander specifics [read]

| Rule | Where |
|---|---|
| Command zone, casting from it, zone return | `GameState.command_zone`. `game/commander.rs:132` (CR 903.9a, return from graveyard or exile as an SBA choice). Tests: `integration_commander_sba_offers_zone_choice_on_death`, `..._accept_moves_to_command` (commander.rs:1463-1547). Integration test `issue_2377_mdfc_commander_zone_revert.rs`. |
| Commander tax | `commander_tax` (commander.rs:11), `record_commander_cast` (:21), per commander for partners. Tests `commander_tax_increments_correctly`, `integration_commander_cast_from_command_zone_with_tax` (:429, :1092). Shown in `legal_actions_with_costs` spell costs. |
| Commander damage | `GameState.commander_damage: Vec<{player, commander, damage}>`. SBA in `game/sba.rs:821`, threshold from `FormatConfig` (21). Tests `sba_commander_damage_21_eliminates_player`, `..._20_does_not_eliminate` (sba.rs:4878, :4901). |
| Color identity | `commander_color_identity` (commander.rs:175), `validate_commander_deck` (:305), `deck_validation::card_color_identity` (:3434). Tests `validate_commander_deck_wrong_colors` and others (commander.rs:983-1071). |
| 4-player priority | APNAP pass order `game/priority.rs:373`. Multiplayer elimination in `game/elimination.rs`. Many `*_4p.json.gz` fixtures in `crates/engine/tests/fixtures`. The all-AI runner `ai-commander` plays 4-player Commander end to end and is phase's soak harness (pod-lab). |

## 7. Licensing

- **[read]** Workspace `license = "MIT OR Apache-2.0"`. Covered crates: `engine`, `phase-ai`, `server-core`, `seat-reducer`, `phase-llm` and the rest (`license.workspace = true`). Repo files: `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`.
- **Exception:** `crates/manabrew-compat` is **AGPL-3.0-or-later**. Don't depend on it. Neither engine nor phase-ai does.
- **Card data:** derived from MTGJSON (MIT, credited in `NOTICE`). The card text itself is Wizards IP, used under the Fan Content Policy (`DMCA.md`). No card images are bundled; they come from Scryfall at runtime, which matches ARCHITECTURE section 11.
- **Client assets** in `client/public/audio` (for example `Hitman.mp3`, `Failing Defense.mp3`, plus Suno-generated tracks per `scripts/suno-generate`) have no license file. Don't copy them into Yama without checking where they came from.
- `client/package.json` is `"private": true` with no license field. I assume the repo-level dual license covers it **[inferred]**.

## 8. Recommended design for Yama

### Fork and pin

- `yama-phase` fork at tag v0.113.0, with one commit: drop `cargo-features` and the two `codegen-backend` lines.
- Depend on it by git rev from `server/Cargo.toml` (a `server/src/play/` module, or a new `play` crate in the workspace later).
- Pin the card data by SHA in a config file. A `jobs` step downloads it, checks the hash, and stores it outside the repo.

### Trait

```rust
pub struct Seat(pub u8);
pub struct EngineVersion { pub engine: String, pub card_data_sha256: String }

pub struct NewGame {
    pub seed: u64,
    pub seats: Vec<SeatDeck>,          // index = seat; SeatDeck { commander: Vec<String>, main: Vec<String> } (engine names)
}

pub trait RulesEngine: Send + Sync + 'static {
    type State: Clone + Send;
    type Action: Serialize + DeserializeOwned + Clone + Send;
    type View: Serialize + Send;       // per-seat payload: filtered state + legal actions + costs + interaction
    type Event: Serialize + Send;

    fn version(&self) -> EngineVersion;
    fn resolve_deck(&self, cards: &[DeckCard]) -> Result<SeatDeck, DeckProblems>;   // oracle_id -> engine name, unsupported list
    fn validate_decks(&self, game: &NewGame) -> Result<(), Vec<String>>;            // validate_name_deck_for_format_full
    fn new_game(&self, game: &NewGame) -> Self::State;                               // = reconstruct_initial_state(header)
    fn acting_seats(&self, s: &Self::State) -> Vec<Seat>;
    fn is_over(&self, s: &Self::State) -> Option<GameResult>;
    fn apply(&self, s: &mut Self::State, seat: Seat, a: Self::Action)
        -> Result<Applied<Self::Event>, Rejection>;                                  // apply_with_rejection; returns events + log + RecordKind
    fn view(&self, s: &Self::State, viewer: Option<Seat>, last: &Applied<Self::Event>) -> Self::View;
    fn ai_step(&self, s: &mut Self::State, ai: &AiSeats) -> Option<(Seat, Self::Action, RecordKind, Applied<Self::Event>)>; // run_ai_action
    fn replay(&self, header: &ReplayHeader, log: &[Recorded<Self::Action>], upto: u32) -> Result<Self::State, Desync>;
    fn snapshot(&self, s: &Self::State) -> Vec<u8>;                                  // optional cache
    fn restore(&self, bytes: &[u8]) -> Result<Self::State, String>;
}
```

`RecordKind` mirrors phase's `Submitted` / `VerifiedAiPriorityPass { semantic_owner }` plus the Resolve All boundary, so playback stays exact. The `PhaseEngine` impl holds one `Arc<CardDatabase>`.

### Runtime

- One `GameActor` tokio task per live game, owning the `State`, an `mpsc::Receiver<GameCmd>` (Submit, Connect, Disconnect, Concede) and a revision counter.
- Engine and AI calls run on a dedicated rayon or std thread pool with 32 MiB stacks, awaited through a oneshot. They're CPU-bound and recursive.
- Clients send `{expected_revision, action}`. A stale revision is rejected.
- After each accepted action the actor:
  1. Appends to `game_events`, in one transaction.
  2. Bumps the revision.
  3. Sends `view(state, seat)` to each connected seat's socket, and `view(state, None)` to spectators.
- AI seats: after every accepted action, loop `ai_step` while an AI seat must act.
  - Persist and broadcast each step, with a small delay for animation.
  - Cap steps per batch. Treat `ChooseActionNone` or `ApplyFailed` as a "driver fault" that pauses the game; server-core has `AiDriverFault` for the same thing.
- Timeouts and auto-pass: phase exposes `auto_pass_recommended`. A turn timer lives in the actor, not the engine.

### Persistence (existing tables)

- `games.engine_version` stores the version string from section 3. `games.seed` stores the u64 bit-cast to i64.
- `game_events` row 0 is `kind = 'engine_header'` with the `ReplayHeader` JSON (deck names already resolved).
  - Each later row has `seq`, `actor_seat`, `kind = 'engine_action'` and payload `{action, record_kind}`.
  - Resolve All boundaries get `kind = 'engine_resolve_all'`.
- Restart recovery: replay the log (`ReplayPlayer`-style). Optionally add `game_snapshots(game_id, seq, state)` every N actions or each turn, holding `PersistedGameState` JSON (zstd), to speed up recovery and old-version viewing. Never reseed on restore.
- A `ReplayLog` is just this data reassembled, so Yama can export phase-compatible replay files.

### Per-seat views over WebSocket

Copy the field set of phase's `ServerMessage::StateUpdate` (server-core/src/protocol.rs:804), built as in `phase-server/src/main.rs:698`. That keeps phase's client usable (next section). Keep `GameAction` JSON exactly as phase serializes it.

### Browser board

- Phase's client (`client/src`, about 1,400 TS files, React 19, Tailwind 4, framer-motion, zustand 5) talks to engines through the `EngineAdapter` interface (`client/src/adapter/types.ts:5234`).
  - Its `ws-adapter.ts` speaks the phase-server protocol.
  - Board components read from the zustand `useGameStore` (`stores/gameStore.ts`).
- **Hard dependency:** card rendering (`CardImage`, `CardPreview`, `CommanderCardZone`, `CommandDock`) uses `hooks/useEngineCardData.ts`, which calls the **WASM** adapter for card faces. That means the 101 MB card data plus the engine WASM in the browser, built with nightly and wasm-bindgen (`scripts/build-wasm.sh`; not installed here).
- Recommendation: fork into `packages/board` and add a `YamaAdapter implements EngineAdapter` over Yama's socket, sending phase-shaped `StateUpdate` payloads.
  - Replace `useEngineCardData` with a lookup against Yama's own cards API (Scryfall oracle data), so phones never download the WASM or the card data.
  - Keep the WASM only for an optional offline or solo mode later.
  - The client uses pnpm (not installed). npm may work against `package.json` but is untested.

### Implementation order

| # | Step | Effort |
|---|---|---|
| 1 | Fork phase, apply the manifest patch, pin the rev. Card-data download job with SHA check. Rerun this demo with `CARGO_INCREMENTAL=0` once there's about 4 GB free. | 0.5 day plus about 30 min first build |
| 2 | `RulesEngine` trait plus `PhaseEngine` impl. Deck mapping from oracle_id with an unsupported-card report on the deck page (coverage file or engine parse warnings). | 1 to 2 days |
| 3 | Headless all-AI soak test in `server/` (Bryan's decks, many seeds), checking replay equality at the end of each game. Catches stack overflows, AI stalls and desyncs early. | 1 day |
| 4 | `GameActor` task, persistence to `game_events`, restart recovery by replay. | 2 to 3 days |
| 5 | WebSocket protocol (phase `StateUpdate` shape), per-seat filtering, spectators, reconnect, revisions. | 2 to 3 days |
| 6 | Lobby and seats (humans and AI seats with difficulty), deck validation gate. | 1 to 2 days |
| 7 | Board: fork the phase client into `packages/board`, `YamaAdapter`, card data from the Yama API instead of WASM. | 4 to 7 days (largest unknown) |
| 8 | Replay viewer (server-side `seek`, streaming views), snapshots for old engine versions. | 2 days |
| 9 | Upgrade procedure: bump the fork, new card-data SHA, soak test, tag `engine_version`. | ongoing |

## Bryan's decks

- **[ran]** The 2026-10-17 `coverage-data.json` (35,923 cards; Commander 30,494 of 32,950, 92.5%) contains every name in `Fantastic_Four_Upgraded_100.txt` and `Riders_of_Rohan_Upgraded_100.txt` (100 cards each; the first line is the commander).
- Unsupported:
  - **Negative Zone Portal** (gap `Effect:unparsed_condition`)
  - **Combat Celebrant** (gap `Swallow:Duration_ThisTurn`)
- That coverage file came from phase's preview channel a day before v0.113.0. Resolving these names against the v0.113.0 `card-data.json` was part of the demo and is not verified.
- Accented names such as "Éowyn, Shieldmaiden" resolve through `CardDatabase::lookup_key` **[read]**; not run.
