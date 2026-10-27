# Simulator performance investigation, 27 October 2026

The objective is lower latency for full four-player Commander games, preserving the frozen
lists, AI policy, seed and scored outcomes. Higher parallel throughput, simpler AI and a
different engine's faster but different game are separate results.

## Baseline and measurement boundaries

This investigation starts at Yama `b0d835276241e110fc0693f3b4ca09de80f5544f`, with Phase
`8aff83ece446e16ecc12ad05066a0d62bc223cbd`. The existing
[decision preparation optimization](phase-performance-2026-10-27.md) is already included;
its 460-to-285-second slow replay improvement is not a new result here.

The completed 200-game-per-engine experiment `830e244c-1eb3-4532-8a1a-30b9ea54e275`
gave Phase a median of about 5 seconds, mean 6.53 and p95 14; Forge's median was about
59 seconds, mean 110.79 and p95 378. These are approximations from rounded MCP game times,
including failures: 198 Phase wins / 2 errors and 197 Forge wins / 3 timeouts. They are
historical observations, not fresh timings of the new loader, latency guarantees or evidence
of equal gameplay correctness. The stored Phase fixture identifies its runner as
`unknown-078afb59/isolated-linux-2g-v1`; the original source SHA is not established by that label. The active 190-deck
tournament has a heavier tail and is not a completed comparison.

`GameResult.ms` is elapsed game time, despite the current MCP's “CPU” wording. Phase's CPU
budget uses a different clock; its child database load precedes the game timer. Forge's
logged milliseconds normally exclude JVM/card-loading startup. Whole-process wall time,
user plus system CPU and peak RSS must be measured separately. The existing Forge runner
already collects these metrics, but its HTTP wrapper discards them. The offline benchmark
captures them without altering the scoring protocol.

## Phase database loading

Every isolated child loads the full 101,470,976-byte card export
`1e5608e61683de41c84f08f70115bef38db13df85bc5e01fd0eb249cf023244d` (36,051 faces).
Phase exposes both reader and string deserializers, which converge on the same database
constructor. Yama can avoid the byte-at-a-time reader interface by reading a complete
string first. The string is dropped before gameplay starts. No deck-only subset is used:
name/type discovery and generated cards can require cards outside the scheduled lists.

Six separate processes on the M3 Pro, ordered reader/string/string/reader/reader/string,
using the existing release engine libraries and mimalloc:

| Loader | Load seconds, three runs | Mean | Peak process RSS |
|---|---|---:|---:|
| Reader | 0.8830, 0.9482, 0.9449 | 0.9254 s | 679–680 MiB |
| String | 0.5900, 0.5717, 0.5894 | 0.5837 s | 776–777 MiB |

This is **37% less loading time**, saving about **0.34 seconds per child** on this host,
with roughly **97 MiB more transient memory**. It is a startup optimization, not a 37%
whole-game speedup. The 2 GiB child limit, process isolation, card export and engine pin
remain unchanged. Longer games still need AI/legal-action/trigger optimization.

The pinned candidate was then measured on saget (i7-7820X, 8 cores / 16 threads, 32 GiB),
under a one-CPU quota and the actual 2 GiB process data limit, while other server work
continued. Rust 1.99.1, release opt-level 2, mimalloc; candidate runner
`b0d835276241e110fc0693f3b4ca09de80f5544f-dirty-8731de32`:

| Loader, Linux | Load seconds, three runs | Mean | Peak process RSS range |
|---|---|---:|---:|
| Reader | 2.5893, 2.3638, 2.7041 | 2.5524 s | 665–691 MiB |
| Current string loader | 1.8355, 1.9451, 1.4224 | 1.7344 s | 749–789 MiB |

That is **32% less loading time**, or **0.82 seconds per child** on this shared host.
The full-data equivalence test passed for every face, storage key, card-name list,
creature-type vocabulary, printing list and front-face classification. Measurements are
from the isolated candidate on the starting base; subsequent main integration is checked
separately by CI.

Three saved Phase games also reproduced **every result field except timing and runner**:

| Fixture | Turns | Actions | Candidate game elapsed time on Linux |
|---|---:|---:|---:|
| 0 | 43 | 1,850 | 9.353 s |
| 1 | 50 | 2,270 | 8.545 s |
| 3 | 59 | 3,110 | 33.223 s |

These are preserving replay checks through the offline lab, not a measured whole-game
A/B speedup or a change to the production child execution model.

Reproduce with `cargo build --release -p yama-play --bin loadbench`, then run each mode in
a separate process under `/usr/bin/time -l` (macOS) or `/usr/bin/time -v` (Linux):

```sh
target/release/loadbench reader "$YAMA_ENGINE_CARD_DATA"
target/release/loadbench current "$YAMA_ENGINE_CARD_DATA"
```

## Forge runtime screen

Forge 2.0.15, Java 17, Default AI, 1536m heap and two advertised JVM processors. Three
saved four-seat requests from the completed experiment were replayed locally, sequentially,
at nice 15. They use seeds `12415820392783289394`, `16223208404063034616` and
`2448955124488207003`; the worker applies its existing low-63-bit Forge seed mapping.
Each trial starts a fresh JVM, uses a 120-second game cap, and writes no server results.
No trial modifies the installed Forge distribution or user settings.

Runtime identities verified from the installations used: Mac Homebrew OpenJDK 17.0.19+0;
Linux Temurin 17.0.20.1+1. Both have jar SHA-256
`85a4c31e07d4d5621a84bb03b6d75fd08e9f4ba289e575c870579b49c0033766` and card-archive SHA-256
`ac26ccbe2a9c015bad4851db61d57d421777e10bf96c32d72add618b258bec07`.

| Runtime | Whole-process wall seconds, cases 0 / 1 / 3 | CPU seconds, cases 0 / 1 / 3 | Peak RSS, MiB |
|---|---|---|---|
| Default G1 | 25.37 / 57.59 / 86.54 | 50.96 / 87.53 / 121.27 | 1011 / 980 / 1006 |
| Serial GC | 24.93 / 59.80 / 90.67 | 49.60 / 86.31 / 121.76 | 615 / 676 / 719 |
| Parallel GC | 23.56 / 51.41 / 80.15 | 46.55 / 77.63 / 113.42 | 958 / 999 / 1025 |

All nine above finished with matching observable result fields, excluding timing and build
label, and zero reported AI evaluation timeouts. Serial GC reduces memory but does not
improve latency consistently. Parallel GC is promising at roughly 7–11% lower wall time;
this initial screen is one trial per game/configuration, not a statistical workload estimate.
An alternating-order repeat of case 0 produced default/parallel/parallel/default wall times
of 22.30 / 21.93 / 24.21 / 27.77 seconds (all matching wins). Means were 25.04 and
23.07 seconds, about 8% apart, with substantial run-to-run noise.
However, the same case under a one-CPU Linux container on saget reversed that result:

| Collector, Linux | Wall | CPU | Peak RSS |
|---|---:|---:|---:|
| Default G1 | 147.85 s | 147.12 s | 1070 MiB |
| Parallel GC | 163.38 s | 162.72 s | 957 MiB |

Both were matching 35-turn wins with zero AI timeouts. This is one pair on a shared host,
not production's four-slot workload, but it is enough to reject a universal GC speedup
claim. **Keep production defaults unchanged.** The test used the installed image
`sha256:e7133ce0e6f1e92c13b8e83cee764be9bab4a2941e98bc865cf666234ffe1065`, one CPU,
2 GiB memory, and otherwise the same 1536m heap / two advertised JVM processors.
The repeats and Linux pair retained the saved 600-second cap. Linux's logged game times
were 123.831 and 139.491 seconds, exceeding the initial Mac screen's 120-second cap;
only the within-Linux pair is compared for that result.

Restricting compilation with `-XX:TieredStopAtLevel=1` made the first matched job slower
(36.83 seconds versus 25.37). Both remaining C1 trials hit the 120-second cap;
case 1 also reported two AI evaluation timeouts. It is not a latency recommendation.

An exploratory `-n 3` batch of case 0 took 105.28 seconds, 148.16 CPU seconds and
998 MiB peak RSS, with one AI timeout. This does not demonstrate a pooling speedup:
later games consume a continuing RNG sequence and have different outcomes/workloads.
A batch cannot replace three individually scheduled seeded jobs without a separate
seed/reset protocol and validation. No batch result was submitted or scored.

Use the checked-in harness for alternating-order repeats. Inputs are saved `/play` request
objects containing `spec` and frozen `decks`; the tool generates its own request keys and
calls the offline worker directly. The requests and output contain private data: keep them
under ignored `data/`. Do not submit benchmark results to the lab queue.

```sh
python3 tools/bench_forge.py data/request.json \
  --forge /path/to/forge-2.0.15 --java /path/to/java \
  --variants default parallel --repeats 2 --out data/forge-abba.jsonl
```

Each JSONL row retains full result, request SHA-256, engine/card/runner identity, Java version
output and SHA-256 of the Forge jar and card archive (read before timing), JVM
options, heap and processor settings, per-process metrics and baseline equality. Reversed
variant order on the second block produces ABBA for two variants. A matching timeout or
error never qualifies as matched completed work. Matching end-state fields is weaker than
an identical action trace; Forge's wall-clock AI timeout remains load-sensitive.

## Community findings

- [NeoForge](https://github.com/AdrianLopez98/NeoForge) is a JavaFX frontend on Forge's
  existing engine and AI. Its documentation supplies no comparable simulation speedup.
- [Commander AI Lab](https://github.com/KoalaTrapLord/commander-ai-lab) combines full-rule
  Forge with a separate fast Monte Carlo model. Its
  [persistent-pool issue](https://github.com/KoalaTrapLord/commander-ai-lab/issues/83)
  describes a throughput target, not a measured Commander benchmark. Fast Monte Carlo
  model rates cannot be assigned to its full Forge games.
- [Gorge](https://github.com/adams-shaun/gorge) is a newer Go engine with actual published
  [cross-engine measurements](https://github.com/adams-shaun/gorge/blob/main/docs/site/performance/index.md).
  Its roughly 8–10 ms heuristic games use two-player, 40-card Foundations draft decks;
  even Forge is around a second in that warmed-up benchmark. Different AI policies and
  rules coverage prevent transferring those ratios to our Commander workload. Gorge's
  README explicitly disclaims rules parity and production readiness. This is a candidate
  for a future coverage audit, not a drop-in replacement accepted by these tests.
- [Oracle's Java 17 collector guidance](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)
  supports testing collector choice against the actual workload; it does not establish
  that any collector is universally fastest.

Only public usage/benchmark documentation and our wrappers were inspected for other
engines. No Forge implementation was used to develop Phase changes.

## Execution and remaining boundary

Validation before the PR:

- Full workspace `cargo test --release --locked --offline` on the isolated candidate:
  **1,546 passed, zero failed, 46 ignored**. An initial attempt failed on macOS archive
  metadata files beside SQL migrations; removing only those transfer artifacts fixed it.
- The full-workspace-built `loading` test executable passed the additional full-corpus
  test directly; all three frozen Phase result comparisons passed. No narrower Cargo
  feature graph is substituted for that evidence.
- After integrating main `5b54bf4`: **529 web tests passed, seven skipped**, and type checking
  passed. Ten Python worker/benchmark tests and 18 release-guard tests passed.
- The final Forge harness completed a real game with runtime fingerprints. Real Ctrl-C
  and SIGTERM smoke tests both exited without a result row or a surviving benchmark JVM.
- Initial Codex source review identified two reporting/provenance issues, both fixed.
  The subsequent independent source/evidence review found no actionable issues. These
  reviews did not independently execute the test suite; PR checks/review remain separate.

Local tests reuse existing compiled engine libraries and the installed Forge distribution;
no large new Mac Rust target was created. Rust workspace validation runs on saget in a
separate container capped initially at one CPU / 4 GiB, then two CPUs / 8 GiB for the retry,
using a private copy of the existing build
cache and the exact Phase pin, without network or production database access. Production
tournament workers were neither stopped nor reconfigured. A separate Forge GC screen
uses one CPU, 2 GiB, a read-only filesystem, private temporary scratch, no network and no
production data mount. No production deployment is
part of this change.

The evidence does not establish two-second full Commander games across these lists.
Phase is already near that latency on some local replays; its long tail remains expensive.
Forge startup and GC tuning alone do not explain its minutes-long tail. Any persistent
worker must preserve per-game seeds, seat mapping, immutable build/card identity, hard
failure containment and owner isolation before its throughput can enter scored comparisons.
