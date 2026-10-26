# Engine recovery, 25 October 2026

This is the local continuation of the interrupted rules, parser and performance
work. It does not establish feature parity with Forge. The original worker
branches and unfinished edits were preserved before integration.


## Current acceptance state, 26 October

The local candidate is Phase `a3bc47c922d3b6d1990cc826b887399d749c58e8`;
Yama's candidate pin and replay version identify it. It is **not accepted**.
The production library compiles, and 20 existing integration tests in 11 unchanged
source files pass against its Cargo-reported engine artifact. All 36 patches
reproduce its tree `047d29f4b479f059453d14482e8c33f5e8425dd6` exactly.

Two gates remain observed failures. The unit-test build reports three E0609
errors in the six new regressions: they read a nonexistent `Player.exile` field
(at effects/mod.rs lines 48395, 48698 and 48699); exile belongs to GameState.
The new regressions and full unit suite have not executed. The newly authorized
prescribed Opus review also failed immediately at the Claude API rate limit.
Earlier source-clean reviews and pre-repair test passes do not close either gate.
The authorized two-dispatch extension is spent; no further fix or review cycle
is silently opened. Candidate Yama, replay, referee and lint execution now passes as detailed below.
The combined `2ffbe85` app base passes 1,461 Rust tests with 38 ignored.
Fetched main `a1c8a22` is now merged locally as `41cc320`; the combined result
passes 1,462 Rust tests (38 ignored), 494 JS tests (two skipped), typecheck and
the production web build.
These production results do not close the unit-test or review blockers.

See `engine-candidate-artifacts.jsonl` / `engine-candidate-build.log` and the
individual `integration-*.log` files in the ignored recovery directory. Those
integration files ran directly through standard rustc/libtest against the exact
candidate rlib, without introducing another source harness or test target.
The eleven completed 235 MB test executables were deleted to recover 2.7 GB;
their SHA-256 hashes and sizes remain in `integration-candidate-artifacts.json`,
and all source/build/result logs remain. No other thread's artifacts were removed.

## Source and clean-room boundaries

The integration starts at Phase `3bbfea64ce05a95a540d12734d473286052a49c2`,
with the separately written Blood Moon/Urborg dependency fix `6e1c476`.
The recovered work comes from `fix-work` through `912b273`, `parser-work`
through `910832b`, and `perf-work` through `75a9f88`, plus their saved unfinished
diffs. New implementers receive Phase source, Oracle text, the Comprehensive
Rules, and the existing written specs. They do not receive Forge source or
runner code. The parent handles integration and black-box runs; those results
do not supply implementation code.

The app work is isolated in `engine-recovery-2026-10-25`, preserving other
threads’ working files. Before final app checks, it was fast-forwarded to freshly
fetched `origin/main` at `117e7a6`. Publishing and deployment are separate work;
GitHub must be fetched and reconciled again before any release.

## Performance reproduction

The recovered performance branch, including the unfinished no-op hand/stack
reset optimization and the conservative projected-Battlefield trigger correction,
was rebuilt and rerun against the preserved `lab-base`
binary. Both use the same seven schedules, one game thread and the same
`card-data-eb309108eb0df708.json`. Six games use Easy and one uses Medium.
Every result field except `ms` agrees, including winners, placements,
eliminations, turns, actions and final life totals.

Fresh measurements on the same Mac:

| Game | Baseline user CPU, s | Optimized user CPU, s | Retired instructions, billions, before / after |
|---|---:|---:|---:|
| precons-1-1 | 8.81 | 2.39 | 89.0 / 29.2 |
| precons-1-11 | 10.53 | 3.27 | 112.0 / 41.0 |
| precons-1-21 | 13.86 | 3.47 | 157.2 / 37.3 |
| precons-1-23 | 5.05 | 2.38 | 44.1 / 25.4 |
| precons-1-25 | 22.54 | 3.83 | 242.4 / 45.3 |
| precons-1-27-medium | 48.53 | 8.02 | 448.5 / 91.5 |
| precons-1-5 | 15.46 | 5.92 | 122.9 / 64.8 |
| Total | 124.78 | 29.28 | 1216.2 / 334.5 |

The seven games used about 77% less user CPU (a 4.3× speedup) and 73% fewer
instructions. The baseline run overlapped other builds, so instruction counts
are the stronger evidence.
These are seven benchmark games, not a promise of this speedup on every deck.
The saved baseline predates the final combined rules/parser batch; that batch
may correctly change game outcomes and must have a new engine label.

The principal changes share immutable card names and static-source gathers,
avoid unchanged copy-on-write updates, reject irrelevant trigger sources
before cloning them, and enumerate semantic action candidates once per AI
decision. Source review is supplemented by direct cache-transition and clone/serde
regressions. The full debug suite exposed a valid projected Battlefield source
in a virtual stack entry; a conservative precheck fallback fixes it, with two
regressions covering reconciliation and pending-activation collection. Neither
the source review nor the seven-game gate proves equivalence for all games.

## Referee baseline

The same 6,547-card corpus was reconstructed from the 198 deck files. Basic
lands and Snow-Covered basics are excluded. With the pre-integration runner
and `card-data-2905717cc9fe0f53.json`, the current harness ran 6,360 scenarios
and skipped 187:

- 6,006 agree.
- 226 differ.
- 40 are refused by both engines.
- 21 Phase errors, 61 Forge errors, and 6 errors in both.

The 20 hand-written scenarios agree in 19 cases; `blood-moon-urborg-c4`
already differs in this baseline. Counts are observations, not rules-correctness
percentages: AI choices, randomness and runner limitations can cause differences,
and both engines can be wrong. No combat, multiplayer or X-spell parity is
established by this sweep.
At the pre-repair `1348e65` pin and regenerated data, the 20 hand-written
scenarios still agree in 19 cases. The same pre-existing `blood-moon-urborg-c4` difference remains.
That pre-repair sweep runs the identical 6,360 scenarios and skips the same 187:
6,028 agree, 209 differ, 40 are refused by both, 20 have Phase errors, 57 have
Forge errors and six have both. Eighteen former differences, one Phase error
(Noble Quarry) and four Forge errors become agreements. One former agreement,
Living Death, becomes a difference and is under independent clean-room rules
triage. There are no newly introduced Phase errors. The improved totals are not
a regression-free verdict until that new difference is resolved.


At candidate `a3bc47c`, the saved Living Death resolved scenario agrees with
Forge. A fresh full sweep (`sweep-final`) runs the same 6,360 byte-identical
generated scenarios, in the same order, with the same 187 skips: **6,029 agree,
208 differ, 40 both-refuse, 20 Phase errors, 57 Forge errors, six both-error**.
Relative to the baseline, 18 differences, one Phase error and four Forge errors
become agreements; no former agreement regresses. Relative to the pre-repair
run, only Living Death changes verdict, from difference to agreement. Its full
card definition and resolved selections are unchanged across all three runs.
The 20 hand-written scenarios again produce 19 agreements and the same sole
pre-existing `blood-moon-urborg-c4` difference (the comparison command exits 1,
not a passing all-scenarios check). Source review and remaining unit gates are
still required; these observations are limited to these scenarios. Detailed
transitions are saved in `sweep-final-transitions.json`.

## Card export and parser gaps

The final parser export is `card-data-1e5608e61683de41.json`, 101,470,976 bytes,
SHA-256 `1e5608e61683de41c84f08f70115bef38db13df85bc5e01fd0eb249cf023244d`.
It uses the same archived MTGJSON build and 460 set files as the preceding
`2905717c` export. The pinned reader accepts all 36,051 faces and its integrity
checks pass. Two generations produce identical card exports and name lists.
The local compressed copy has SHA-256
`5b6cd1a178496bb089da6926db430f2c9c4b594d19a6ee28d5a25dbfe77533aa`.

The export changes 118 faces, adds none and removes none. Across the same
6,547 card names, explicit unimplemented effects fall from 406 to 367: 42 clear
and three become explicit gaps (Blaster Hulk's energy cost, Lumbering Megasloth's
counter-dependent reduction, Seal of the Guildpact's chosen colors). Those three
previously accepted incorrect cost readings and now fail conservatively.
Warnings fall from 117 to 115 overall; Anowon, the Ruin Thief and Ghouls' Night
Out gain warnings. No corpus name is missing. These counts do not prove runtime
correctness or complete support. Shaile, Impact Resonance, Kazuul and the
another-Human-died predicate remain unsupported where their semantics are missing.

The reconstructed corpus contains exactly the baseline names. Equal-frequency
cards use a deterministic alphabetical tie break in `corpus.py`, so its ordering
differs from the original snapshot. The before/after sweep uses that original
snapshot's order unchanged.

The regenerated coverage report classifies 741 of Bryan's 779 deck/candidate
cards as full (previously 738), with 13 uncertain and 25 partial. In the 174-precon
catalog it classifies 5,910 of 6,429 as full (previously 5,871), with 149 uncertain
and 370 partial. The fixture contains 807 faces; all 779 smoke entries and their
existing ignore attributes are unchanged. These are coverage classifications,
not proof that every interaction is correct.

## Artifacts

Local logs, original diffs, input snapshots, executable hashes and full results
are under `data/engine-recovery/2026-10-25/` (ignored by git). The seven original
schedules and per-game CPU/instruction measurements are also retained under
`~/Developer/perf/bench/`. Incremental compiler caches and the completed input extraction were removed to
recover disk space; source, patches, test executables and the original inputs
archive were retained. The shared Phase checkout was restored to its original
`referee-next` branch; the isolated sibling worktree owns the recovery branch.

`referee/corpus.py` recreates a deterministic card list for `sweep.py` and can
compare explicit parser gaps between two exports. Parser gap counts alone do
not demonstrate that the card behaves correctly.

## Validation checkpoints

Phase checkpoint `b4bc345650cc6f4e352173463540c79533200c1e`:

- `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 cargo +stable test -p phase-engine --lib --test recovery --features cli -- --test-threads=4`: 24,441 unit tests and 13 focused runtime tests pass; eight unit tests ignored.
- `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 cargo +stable test -p phase-ai --lib --features engine/cli,engine/test-support -- root_reuse chooser_hands pact_drafting_skips --test-threads=4`: four pass.
- Stable formatting, parser-combinator gate and parser skill-document gate pass.
- The upstream v0.113.0 tree plus the complete local patch series and checkpoint diff reproduces the checkpoint tree exactly.

The checkpoint used a temporary focused target importing the original integration
modules. It covered addendum population relays, normal and bestowed casts,
chosen-player quantities, per-player sacrifices, independent conditional
sentences, and each creature damaging itself. That extra target was subsequently
removed because Phase forbids top-level test files; all regression modules remain
registered in the normal integration suite. Both existing layout guards pass
when compiled directly with the engine crate's manifest directory. An initial
guard probe used the workspace directory instead and failed to find its inputs;
that setup failure is not evidence about the source. The full integration target
with roughly two thousand modules was not linked for this recovery; an earlier
`cargo check --tests --features cli` checked its compilation.

An independent Codex integration review found two new incorrect acceptances:
Shaile's historical control qualifier and Impact Resonance's source-to-recipient
damage maximum. Candidate `9e423721aa9bf85356dc472bc1ec5c989077b891` withdraws
both mappings through existing explicit-gap paths and adds seven regressions
with supported neighboring forms. A fresh review of the exact four-file delta
returned no source findings. Its full unit run passed 24,444 tests and failed two
new test expectations; eight tests were ignored. All 13 focused runtime tests
passed. The failures were in the authored assertions: Shaile included an unrelated
keyword gap, and the Draw instruction is rejected earlier by the existing
`unparsed_quantity` guard. Production was left unchanged. Test-only checkpoint
`7869bd07bec05800ffe17b83d3141cac17ee63ac` isolates Shaile's activation and pins
the Draw guard, full instruction and rejected operand. A fresh independent review of the test-only correction found no issues and
confirmed its positive reach witnesses. The next seven-test run passed six and exposed one remaining authored fragment
expectation: the diagnostic omits the generic duration tail. The final test-only
correction pins that fragment while separately checking the complete ability
source and quantity operand. All seven tests now pass at the final checkpoint.
A direct census selection passes 25 with one ignored after applying the native
stack setting explicitly; the first direct invocation omitted Cargo's stack
environment and overflowed. The unchanged full-suite results remain attributed
to `9e42372`, rather than being reported as a new final-head full-suite run.
The final independent review of `1348e65` returned no findings and a passing
maintainer-simulation assessment; its completion gate stays deferred until the
remaining combined checks finish.
Final checkpoint `1348e65dc37ae0920d8ec061a3b0f103dcd90c6f` corrects only that
remaining test body and removes the temporary focused harness. All 34 exported
patches reproduce it from v0.113.0 exactly (tree
`888ada2bf097eec68d76a842853c55ddc3a94170`). Production code is unchanged from
`9e42372`, so the deterministic card export still matches this pin. The pre-existing eager
trigger-grant allocator issue is separate and unchanged. The prescribed Opus review could not run because the
Claude API rate limit was reached; the Codex review is advisory, not a claim that
an upstream review gate completed.

Yama was then advanced to freshly fetched main. With
`YAMA_COMMANDER_DECKS=/Users/bryanroscoe/Developer/commander-decks npm test`,
488 tests pass and two are skipped, including successful checks against the real
local planner data. Typecheck and the production web build pass; all 12 release
guard tests pass. This supersedes the earlier isolated run without external data
and the old shared-checkout guide-heading mismatch.

The final four AI root-reuse tests pass again. Engine clippy completed its
check without diagnostics, but the combined lint command stalled in AI clippy.
A native process sample after eight minutes showed 21.8 GB physical footprint
and repeated host-effect trait-resolution calls; after over ten minutes without
a diagnostic, that owned process was interrupted to free the build slot. This
is an incomplete lint check, not a pass or a diagnosed code defect. A separate
engine-only clippy run passes with warnings denied. AI lint resolution remains
pending; the repository's installed pinned nightly is available for a subsequent
attempt without changing source or suppressing lints.

At `1348e65`, the full Yama workspace run with stable Rust and the release profile
passes 1,461 tests with 38 ignored. It used four build jobs, no incremental cache,
line-table debug information and `RUST_MIN_STACK=33554432`. This is pre-repair
evidence: the final sweep independently exposed Living Death's tracked-binding
regression. Clean-room triage confirmed identical inputs and card definitions,
verified the Oracle/rules outcome, and located an overly broad scoped-sacrifice
publication decision. A fresh implementer is repairing that seam with existing
unit-test infrastructure. The failed real-cast witness remains an acceptance
blocker; no deployment or final acceptance is claimed.



## Recovery stop: candidate does not compile (2026-10-26)

The original goal remains completing the recovered rules/parser/performance work,
validating the combined engine and exporting its patches into Yama. This has not
reached final acceptance. The recovered performance measurements, explicit parser
rejections, deterministic export and prior test results above remain preserved.
They do not establish correctness of the latest runtime correction.

Candidate `eecae20f771d1d63278bb0b51c20e719cb564999` changes only
`crates/engine/src/game/effects/mod.rs`: cause-aware tracked-set publication,
automatic replacement-pause continuation retention and six new regressions. It is
committed with a clean worktree and exported as patch 0035. All 35 patches
reproduce its exact tree `e4d33634927e7d949f4314ee8578a22f5086c57b`.
The independent source review reports zero findings and a passing maintainer
assessment, with completion deferred. It did not compile or execute the source.

The parent's candidate compilation fails with E0061:
`effects/stack_reach.rs:692` calls `filter_references_tracked_set(filter)`, while
`effects/mod.rs:9194` now requires the second `Option<ThisWayCause>` parameter.
No new regression test executed. This is a blocking product compiler error,
classified as behavior despite the source review's zero findings. Evidence is
`data/engine-recovery/2026-10-25/living-death-six-tests.log`; the review is
`living-death-review.md`. Neither report is overwritten to hide the discrepancy.

The app pin remains `1348e65dc37ae0920d8ec061a3b0f103dcd90c6f`; the latest
broken candidate is not promoted. The shared original Phase checkout remains
untouched on `referee-next`. Nothing was pushed or deployed.

Attempt history retains the closed plan review (zero behavior, one text), the
failed Opus review dispatch, integration dispatch 2's two behavior findings,
source-clean dispatches 3 and 4 followed by two and one authored assertion
failures, source-clean dispatch 5 followed by the Living Death runtime failure,
and source-clean dispatch 6 followed by this compiler failure. The run record
explicitly bounded dispatch 6 as the last corrective cycle and required a stop
if unclean. No checkpoint or source-clean review resets those limits. No prior
numeric expansion-case prediction was recorded; no earlier result is relabelled
as a successful expansion.

Smallest proposed extension, pending Bryan's approval:

1. Open item: blocking behavior, E0061 at the existing one-argument tracked-filter
   caller. The six new regressions and required combined validation cannot run.
2. Spend: one fresh fix executor restoring the unrestricted helper interface and
   one fresh independent review of the correction, retaining all history. Keep
   changes in the existing effects file unless a newly demonstrated finding
   requires a separate scope decision. Do not weaken tests or required gates.
3. Cost ceiling: two agent dispatches; at most three cold build configurations
   (engine debug tests, Yama release tests/binaries, installed pinned-nightly
   lint), each with at most four Cargo jobs, sequentially. Zero remote CI runs.
   Existing regression/integration tests, replay checks and one final referee
   sweep remain required. The unavailable Opus gate is not waived.
4. If declined: preserve the commits, patches and reports; leave the app pin at
   1348e65 and stop with no PR, push or deployment.
5. Prediction: zero compiler errors, all six new regressions pass, and the next
   independent advisory review has zero behavior findings. Grade this entire
   prediction when results arrive; any remaining verification failure prevents
   acceptance and does not authorize an additional corrective cycle.


## Authorized continuation (2026-10-26)

Bryan explicitly approved the proposed additional fix-and-review cycle and asked
for a tracked goal to get the combined integration working. The goal is active;
acceptance still requires candidate-bound execution. The proposal above remains
as historical stop/approval evidence, not a pending approval. The corrective
executor is constrained to the existing effects file and the compiler omission.
Bryan also clarified that latest development work means Yama's `main`; a fresh
fetch succeeded and `origin/main` remains `117e7a69ba191743845f7f16e4361f70a72e2fe0`,
already the isolated app's base. This authorizes local completion, not a push or
deployment.


## Candidate execution after the compiler compatibility repair

The full Yama stable-release suite at Phase `a3bc47c` passes **1,461 tests with
38 ignored** across 16 result groups. The optimized rebuild took 22m 49s;
`yama-candidate-test.log` and `yama-candidate-test-build.log` bind the artifacts
and results. This supersedes the earlier pre-repair Yama run. It uses the same
four-job, no-incremental, line-table-debug and 32 MiB stack settings, and the real
commander-decks directory. JS/typecheck/web-build/release-guard evidence carries
from the same freshly fetched `117e7a6` app base: no relevant inputs changed.

The candidate coverage binary independently loads all 36,051 full-export faces;
32,108 have no phase coverage gap. Personal classifications remain 741 full,
13 uncertain and 25 partial among 779 cards. The 174-precon catalog remains
5,910 full, 149 uncertain and 370 partial among 6,429. Only the report was
regenerated for the candidate runtime label; the tested fixture and smoke source
were not rewritten.

Both full-game replay tests pass (255.33 s), with no ignored tests in that run.
Seed 21 completes 1,524 actions in 30 turns and resumes identically from saves
at actions 150, 600 and 1,100. The paired concurrent games also match actions,
all seat/spectator views and final states: seed 7 completes 2,422 actions/34 turns,
seed 11 1,771/31, seed 12 (Medium) 1,458/34, and seed 13 1,766/39; all finish with
winners. This uses the exact Cargo-reported candidate determinism executable.

The installed pinned nightly `2026-04-19` (clippy 0.1.97) passes engine and AI
library clippy with warnings denied in 6m 43s. It uses a separate low-debug target,
four jobs and no incremental cache. The earlier stable AI stall remains a failed
attempt in the history; it is not relabelled as a pass. Four current AI reuse
regressions also pass (0.47 s). Fresh JS tests pass 488 with two skipped, typecheck
passes, and all 12 release-guard tests pass.

The separate unit-test compilation and prescribed-review failures at the top of
this report remain open. A narrowly scoped test-only correction
and fresh Codex substitute review have been proposed to Bryan asynchronously;
that proposal is pending, not authorization or a pass.


## Latest main reconciliation

A subsequent successful fetch found `origin/main` advanced to
`2ffbe85cfffcfd8cd3ea16cd7e18e2c22f9b3a4b` (MCP lab queue progress). The isolated
app was fast-forwarded to it after saving the owned tracked delta, staged delta
and file hashes. The owned patch reapplied cleanly; all fourteen non-architecture
recovery files remain byte-identical, and the new main queue-progress sentence
coexists with the recovery architecture updates. Untracked recovery files were
untouched. The saved patch/index/hash artifacts are under the recovery directory.

Only main's server advisor/MCP code and two documentation files changed. Phase,
play, JS/typecheck, replay, referee, fixture, coverage and lint inputs remain
unchanged. Their measured candidate results carry forward for that reason. The
full Yama Rust suite passes again on the combined `2ffbe85` base: 1,461 passed,
zero failed, 38 ignored across 16 groups (`yama-latest-main-test.log`). A later
successful fetch found main advanced to `a1c8a22` (bracket and deck-stat work),
so the tested owned integration is being checkpointed before merging that
fetched revision and verifying its affected inputs. Unit/review blockers remain explicit.
No publish or deployment is authorized.


## Combined local checkpoint and remaining acceptance gates

The owned recovery work is checkpointed as `f81666897f96cf82f06346b6cde843fa402b82ef`.
The freshly fetched bracket/stat main release
`a1c8a22c6b6b20a0cde39463dc2fc02153b0cef3` merges cleanly as
`41cc3201799dcda439e52a1e05088cbffd0b878f`. No push, PR or deployment was made.
A future release must fetch GitHub again; this local task freezes the main
snapshot fetched immediately before integration rather than continuously
chasing unrelated main changes during validation.

The combined result passes the full stable-release Rust workspace suite:
**1,462 passed, zero failed, 38 ignored**, 16 result groups, with a 5m 19s rebuild.
Its JS suite passes **494 with two skipped**; typecheck and the production web
build pass. The earlier 12 release-guard results carry because this merge changes
no release-script input. Logs are `yama-merged-main-test.log`,
`yama-merged-main-test-build.log`, `npm-merged-main-test.log`,
`typecheck-merged-main.log`, and `web-build-merged-main.log`.

The merge changes no `play/`, Phase patch/pin, or referee source relative to the
tested recovery checkpoint. The 20 affected integration passes, two full-game
replay passes, four AI reuse passes, pinned-nightly engine/AI library lint pass,
coverage/data checks and full referee sweep therefore retain their measured
Phase candidate `a3bc47c` identity. They are not claimed as new game reruns on the
later app merge. All 36 Phase patches still reconstruct tree
`047d29f4b479f059453d14482e8c33f5e8425dd6` from v0.113.0.

Acceptance remains incomplete:

| Requirement | Current evidence |
|---|---|
| Production engine/Yama integration | Passed as above; clean committed candidate and merged app inputs |
| Six new Living Death/sacrifice regressions and full Phase unit suite | Not executed: three E0609 errors in two new test bodies incorrectly read `Player.exile` |
| Independent final review | The prescribed Opus attempt failed at its API rate limit; earlier Codex source-only reviews do not close this final gate |
| Additional corrective work | Scoped test-only correction plus fresh Codex substitute review proposed to Bryan; approval pending |

The smallest next step is the pending expansion case: one executor correcting the
three test API assertions while preserving their outcome/ownership checks,
one engine-test rebuild and full unit execution, and one fresh Codex review if
Bryan permits the substitute. Maximum four build jobs, zero remote CI. The
prediction is zero compiler errors, all six regressions and full units passing,
and zero review behavior findings. Earlier failed predictions and design limits
remain in the append-only phase-fit record. No required check is dropped and no
further cycle is assumed. Until approved and verified, this remains a preserved
local integration checkpoint rather than an accepted release.
