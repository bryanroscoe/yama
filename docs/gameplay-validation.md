# Gameplay validation

`cargo test` exercises unit and integration tests but skips the full-data game tests. It is
insufficient evidence that full games finish, replay correctly, or run quickly. Worker process
isolation checks establish that a bad game cannot kill the HTTP server; they do not establish
rules correctness, AI correctness, or throughput.

For game-related acceptance, explicitly run these targets with the pinned card data:

```sh
export CARGO_BUILD_JOBS=1
export RUST_MIN_STACK=33554432
export YAMA_ENGINE_CARD_DATA="$PWD/data/engine/card-data-cbd552b41f962f5b.json"
cargo test --release -p yama-play --test determinism -- --ignored --nocapture --test-threads=1
cargo test --workspace candidate_v0119 -- --ignored --nocapture --test-threads=1
```

The original `lab_regressions` fixtures and historical control (winner 3, turn 54, 2,072 actions)
remain unchanged. They are seeded scenario inputs, not serialized action replays. The new
`lab_regressions_candidate` target uses those exact decks, seats, seed, difficulty and limits
with `candidate-v0119.json` provenance and a full SHA-256 check of the loaded `cbd552b4` bytes.
It requires normal error-free completion of all four failure scenarios. Its control expectation
is independent; a changed result must be investigated before being accepted. Every candidate
result prints the compiled Yama runner identity. Running the old target against new Phase fails
at the old Morph schema; that is not a valid upgrade check. Use the frozen historical sources
in [runtime/README](../runtime/README.md) for historical-only checks. The [30 October investigation](engine-upgrade-acceptance-2026-10-30.md) records the independent candidate control and the two scenarios that still fail.

Both targets fail when explicitly requested without card data. The determinism target requires
normal progress through every AI decision, comparing full action logs, views and final states
between duplicate games and after a restart. Two identical AI failures cannot pass it. Its
60-turn limit remains a deterministic cutoff, rather than a claim that every game finishes.

The live regression target freezes the game seed, seat order, four complete deck lists and
limits from production. The fixture files contain card identifiers, names and quantities, not
card definitions or rules text. The four failing cases are expected to finish normally; the
tests deliberately fail on the current defects. They must not be changed to accept an error.
A successful World Shaper game additionally pins winner, turn count and action count.

## Findings on 27 October 2026

Production Yama `2ecdd08`, Phase `9b2073b`, card data `1e5608e61683de41`:

| Case | Observed behavior | Reproduction |
|---|---|---|
| `d566002e-18-variant` | Verified priority pass rejects an active stack-resolution session | Same failure in the deployed Linux image and the new Rust test |
| `12ea113b-8-base` | Same priority-session rejection in another deck/seed | Same failure in both environments |
| `8b516e4e-147-solo` | Adventure offer has zero engine-issued options | Same failure in both environments |
| `8b516e4e-143-solo` | Combat-tax payment tries to use an already tapped object | Same failure in both environments |
| `24915300-25-base` | Normal control: winner 3, turn 54, 2,072 actions | Unchanged control passed |

The live regression target returned **1 passed, 4 failed**. The full-game determinism target
returned **2 passed**: four Easy/Medium scenarios run twice and one game resumed at three save
points. Missing-data negative checks failed as intended. These passing scenarios do not close
the separate live defects.

All six comparison runs left queued before the worker repair finished by `2026-10-27T08:41:51Z`.
They include 1,200 Phase games: 1,165 wins, 33 errors, one CPU cap and one action cap. Their
Forge halves ran substantially earlier while Phase was paused. Engine completion totals must
be compared over the same active interval, accounting for worker counts and unscored games.

## Throughput baseline and next optimization seam

In the 190-deck tournament, Phase game `449cfd5a-23-t`, seed `3160109258497874`, consumed
432,265 ms on production. It completed normally at turn 44 after 1,903 actions, winner 1. Its
decks were Sneak Attack, Revival Trance (stock), Eldrazi Unbound and Symbiotic Swarm. It occupied
the sole Phase slot for over seven minutes. Forge has three concurrent slots, so its aggregate
throughput is not an equal-concurrency comparison.

Two ten-second CPU samples of a local replay located the work in legal-candidate generation,
spell affordability, automatic mana payment, triggers and characteristic/filter evaluation.
The lab driver issues `AiDecisionContract` and then the chooser independently enumerates the
same state's semantic candidates. In the sampled windows, the caller's contract construction
accounted for approximately 37% and 41% of sampled execution. This is a candidate for sharing
the engine-issued enumeration across choosing and verifying an action; it is not a measured
whole-game speedup. The local trace used its existing diagnostic binary and system allocator,
so its wall time is not a production benchmark. It was stopped after samples were collected.

An optimization must preserve actor/owner authorization, legal-action filtering, candidate
order, RNG consumption and the original successful result. Benchmark the same saved games on
the same machine, recording complete job wall time, CPU time, startup overhead, memory,
timeouts and errors. Child failures currently record zero result milliseconds; excluding those
and startup overhead makes the stored per-game average optimistic. A node budget alone does
not bound the cost of generating a node's legal actions.

The frozen runtime failures and expensive candidate-generation path remain unresolved. The
27 October investigation did not change the production worker count or deploy another image.

## Fork provenance

The investigation's baseline was Phase `9b2073b0986fe580d495fce2fa58b5762e24e3eb`.
The maintained engine now lives in the private `bryanroscoe/yama-phase` repository, with
`origin` pointing there and `upstream` pointing to `phase-rs/phase`. The independent local
checkout is `/Users/bryanroscoe/Developer/engine-recovery/yama-phase`.
Its initial source preserves all 37 former patches and upstream history. Yama's patch files
are retired; releases fetch `deploy/phase-repo` and archive `deploy/phase-rev` exactly.
Other Phase worktrees and branch names are not evidence of what is deployed.

## Subsequent private-fork performance work

The [27 October performance report](phase-performance-2026-10-27.md) records the shared AI
decision preparation, isolated before/after replays, full-data checks and remaining failures.
Its one-case speedup does not close the four frozen gameplay defects or the separate capped
game. The earlier investigation results above remain historical evidence.
