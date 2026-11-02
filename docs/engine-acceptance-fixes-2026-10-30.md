# Engine acceptance fixes, 30 October 2026

The initial acceptance checkpoint preserves the original seeded inputs and both established controls. It is local
validation of private Phase branch `fix/yama-acceptance-20261030` at
`e686ad9050cc342a9c827333390329da2da292da`, on published base
`dd276b0f626c868f43804d0d0cd300d8e7369fbf`. Yama's release pin is still the base. The branch is published in [private Phase PR #14](https://github.com/bryanroscoe/yama-phase/pull/14) and
needs independent review and private-fork integration before Yama can pin it and ship these fixes.

## Changes and discriminating witnesses

- `23042ccc0d20f9eb71a545f4591592560665205b` makes the exact speculative mana search use the
  existing validated mana reducers inside the enclosing announcement. It does not open another
  public action. Murderous Rider's payable Adventure faces remain engine-issued at the cast offer;
  a one-target Hero's Downfall cast no longer trips `announcement_triggers.rs:336`. The reduced
  cast witnesses reproduce the missing offer/payment failure and exact assertion without the fix.
  Actual filter-mana payments resolve the chosen spell normally. Unpayable modal siblings stay
  clean refusals; those siblings pass on the baseline too and are not claimed as red witnesses.
- `b82fd1b940c5d1a85d65792e44a03f511bda68a9` uses the existing living-priority authority after
  resolution and when resetting priority. A three-player Shock/Valgavoth witness verifies that
  the active player's departure preserves their turn while every subsequent priority actor is
  alive and Valgavoth resolves once (CR 117.3b, 800.4j). It fails on the original departed actor.
- The now-reachable seed-10 continuation exposed a Yama adapter mismatch: Phase's legal keep
  answer is `RetargetSpell { new_targets: [None] }`. Yama now admits that one-slot answer only
  when it appears in the engine-issued candidates. The real Deflecting Swat witness reproduces
  the refusal before the fix and keeps Lightning Bolt's original target afterward; Bolt Bend's
  non-issued keep remains rejected without mutation (CR 115.7a/d). This is not a protocol bypass.

Scryfall Oracle and the official 25 September 2026 Comprehensive Rules were checked for the
card/rules decisions. No parser grammar/behavior, original fixtures, debug assertion, limits, or control
expectations were changed. Public main `6334437c31e5c4c40e04c390007e5077994fcdf5` and the exact
upstream seams were inspected first. Open upstream PR #10100's uncastable-offer guard does not
solve this legal filter-mana path; issue #10359's assertion was reproduced locally. No public PR
or comment was submitted.

## Original candidate scenarios

All five finish normally with no error, using the identical decks, seats, seeds, difficulty and
limits with verified data SHA256
`cbd552b41f962f5b80839d35196cfc9621df2406ef3886ca23db8e2f743be505`.

| Scenario | Winner seat | Turn | Actions |
|---|---:|---:|---:|
| Lorehold priority session | 3 | 46 | 2,122 |
| Multiverse Adventure offer | 1 | 61 | 2,905 |
| Multiverse combat tax | 2 | 55 | 2,405 |
| Tricky Terrain priority session | 3 | 42 | 1,931 |
| World Shaper candidate control | 3 | 44 | 1,754 |

The historical control remains **3 / 54 / 2,072**, and the independently established candidate
control remains **3 / 44 / 1,754**. The [original investigation](engine-upgrade-acceptance-2026-10-30.md)
and its results are preserved. The candidate configuration and result engine label still name
the published dd276b0 baseline; these patched local runs instead used the explicit Phase head
above. The final compiled Yama runner is `58f52f931dd6a3ceb5f4c62c78095630ab3286fa-dirty-3a99cc23`.
Task evidence binds the source diff and actual soak binary SHA256; do not present these runs as
validation of an unchanged dd276b0 deployment image.

```sh
# From Yama, with the Phase sibling at the exact feature head above:
git -C ../yama-phase rev-parse HEAD
CARGO_BUILD_JOBS=1 YAMA_ENGINE_CARD_DATA="$PWD/data/engine/card-data-cbd552b41f962f5b.json" \
  cargo test --workspace candidate_v0119 -- --ignored --nocapture --test-threads=1
# Use the binary built by the workspace checks; assertions remain enabled.
DECKS=/Users/bryanroscoe/Developer/commander-decks/decks
RUST_BACKTRACE=1 target/debug/soak data/engine/card-data-cbd552b41f962f5b.json \
  80 10 Easy "$DECKS"
RUST_BACKTRACE=1 target/debug/soak data/engine/card-data-cbd552b41f962f5b.json \
  80 1-20 Easy "$DECKS"
```

Seed 10 passes: winner P2, turn 42, 1,717 actions, zero refused answers, matching replay and
snapshot. The full debug soak passes 20/20 wins, every replay/snapshot matching, zero refused
answers. No performance improvement is claimed.

## Validation boundary

Yama `cargo test --workspace`: 1,650 passed, 0 failed, 52 ignored. The five ignored candidate
acceptance cases were explicitly run as above. Phase formatting and full Gate A pass at the
feature head. Historical native preflight passes all four tests with no skips; the rebuilt worker also passes
the explicit live continuation/completed-board privacy integration test. The first full Phase
integration run passed 14,244 tests with 11 ignored and failed one obsolete reach assertion: it
required the nested filter-mana boundary that the fix removes. Its corrected witness requires
positive live/probe reach, zero nested boundaries, and unchanged trace accounting. The final full
Phase integration run passes **14,245 tests, zero failures, 11 existing ignored**. Strict all-target
Clippy passes with no suppressions. A separate commit fixes ten pre-existing stable-Clippy lints
using equivalent expressions, with no changed grammar, assertions, or cases.

The full Phase library-test compilation exceeded the local compiler guard
(13,324 MiB > 13,312 MiB), exit 137; no library tests ran. It was not retried unchanged or waived.
A larger permitted build environment is still needed for that full check. Private-fork review,
merge and Yama pin/runtime-identity integration remain required. The actual candidate Docker
build and isolated image probe have not run: the local Docker daemon is unavailable. Host
installation and artifact staging have not been performed; no production records were read
or changed.

## Runtime provenance and cache separation

The frozen adapter now builds as Cargo package `yama-play-historical`, retaining Rust library
name `yama_play`. Sharing the old package name allowed its Gitless build-script runner stamp
to replace the current adapter's stamp in the shared cache. Earlier r3 acceptance finished all
five games and 20 seeds but had that invalid embedded stamp; those logs remain diagnostic
behavior evidence only. Final acceptance is repeated after building both packages in the same
cache, and rejects unknown or stale runner revisions. The current stamp also hashes both
embedded runtime manifests; native/Gitless parity tests reproduce and fix manifest-only edits
incorrectly appearing clean.

The frozen export's independently checked source SHA256 is
`7c101bca95223df6e70d56572d6f066c7bd5da45978ced9ee1779c93da96d03e`.
Source/export tampering with unchanged declared identity is rejected. The packaged executable
has a separately generated SHA256 binding checked before execution/replay. Native
`--verify-data PATH` checks real bytes/schema and emits bounded provenance without DB/replay
access. The CLI and installed digest paths match the parent-authored isolated host preflight.
No actual Docker build/probe is claimed from those native and mocked host tests.


## Intrinsic fallback review correction

Private Phase checkpoint `18938c65b1329c53b22f6fa6a5103cfa02245b92` addresses the
subsequent MED review finding. Subtype-only mana activations produce directly, so the
exact mana probe now completes that frame through `collect_completed_mana_frame_events`,
with its existing consumed-occurrence tracking and returned prompt. Indexed activations
and color-choice continuations keep their existing completion ownership; no second
bonus scan is added there.

The reduced Molten Tide/filter-land witness clears the supported subtype-only source
shape after layer preparation and asserts that the prepared probe selects `ability_index=None`.
Normal layer preparation synthesizes an indexed intrinsic ability, which is why the earlier
exploratory probes passed and were not red evidence. With this reach guard, the e686 baseline
fails at the missing engine-issued four-mana cast offer; the fix offers the spell and completes
normal filter payment/resolution. Indexed positive and no-bonus negative controls pass before
and after. An additional five-mana negative, for both indexed and subtype-only shapes, rejects
spending the same bonus twice. This is a latent supported-source-shape regression, not a claim
that a current normal replay naturally creates that shape. Molten Tide's exact Oracle body and
CR 305.6, 605.1b and 605.4a were verified.

At this checkpoint, all nine focused announcement/mana-probe tests pass, the full engine
integration suite passes **14,249 / 0 failed / 11 existing ignored**, and strict Clippy for
`--lib --test integration`, formatting and full Gate A/G/H pass. This scoped lint result is
not a claim that the final-head all-target/CI gates passed. The previous full library-test
memory cutoff and the required hosted Rust archive, WASM proof and card-data checks remain
unwaived. Prior hosted attempts ended in runner shutdown/143 during compilation; those jobs
never reached their proofs/tests, and the shutdown cause is not established.

The new commit's exact format-patch is preserved as `patches/phase/0006-*.patch`, per Bryan's
explicit task instruction. It is provenance only. Private-fork review/integration, the release
pin update and final-head validation remain parent-owned prerequisites; no release input is
silently replaced by this export.


The follow-up is published in private Phase PR14 at the exact checkpoint above. Parent
independent review found no new source findings and passed Maintainer-Simulation, while
keeping validation/ship gates separate. Required fork-range parser-output comparison,
current-head CI and actual candidate-image preflight remain outstanding; no gate is waived.

Current-head acceptance was repeated with compiled Yama runner
`85feb065a4d6baefdda6b121eb67eaa5e0f5ded0` and clean Phase
`18938c65b1329c53b22f6fa6a5103cfa02245b92`. All five cases finish normally with the identical
winner/turn/action tuples in the table above. The strict debug seed 10 run is still P2/42/1717,
and the full 1–20 soak passes 20 wins, zero failed checks/refusals, every replay and snapshot
matching. Both original control expectations and the five input fixtures remain unchanged.
Actual Phase provenance is the feature SHA above; the unchanged release pin/result label
still names dd276b0 and must not be mistaken for the engine used in these local runs.

The parent-owned deferred-settings follow-up at Yama 85feb06 also passes the required
workspace suite: **1,654 passed, zero failed, 52 ignored**; web 668 passed/9 skipped and
typecheck passed. Its regression fails before the fix when an admitted deferred Hold erases
pending AI work, then passes with automatic batch continuation and no new player command.
The queue checkpoint's native historical live/completed recovery test also passed; that
native result is bound to adc399e, not claimed as a new native run after 85feb06.

Use the workspace build so dependency features match the tested artifact:

```sh
# From Yama, with the sibling at the published, reviewed feature checkpoint:
test "$(git -C ../yama-phase rev-parse HEAD)" = 18938c65b1329c53b22f6fa6a5103cfa02245b92
CARGO_BUILD_JOBS=1 YAMA_ENGINE_CARD_DATA="$PWD/data/engine/card-data-cbd552b41f962f5b.json" \
  cargo test --workspace candidate_v0119 -- --ignored --nocapture --test-threads=1
# The workspace test build also builds this non-test binary with debug assertions.
DECKS=/Users/bryanroscoe/Developer/commander-decks/decks
RUST_BACKTRACE=1 target/debug/soak data/engine/card-data-cbd552b41f962f5b.json 80 10 Easy "$DECKS"
RUST_BACKTRACE=1 target/debug/soak data/engine/card-data-cbd552b41f962f5b.json 80 1-20 Easy "$DECKS"
```

Task evidence records all 642 validation-input hashes before/after, the actual soak SHA256
and Cargo's fresh executable/profile record (debug and overflow assertions enabled). The
package-only soak build selected a narrower dependency graph and was cancelled before
producing a new binary; it is neither a check failure nor passing validation. The cached
workspace artifact was verified without compilation and used for the successful soak.
