# Phase performance measurement, 27 October 2026

Yama Phase now has its own private repository at <https://github.com/bryanroscoe/yama-phase>.
The engine's upstream history, licenses and all 37 former patch changes are preserved. Yama
fetches the repository in `deploy/phase-repo` and archives the exact published full SHA in
`deploy/phase-rev`; patch export/application is retired. Generic AI work is a separate commit
from fork-only contributor guidance, keeping future upstream contributions practical.

## Measured change

Phase candidate `8aff83ece446e16ecc12ad05066a0d62bc223cbd` introduces `PreparedAiDecision`.
It enumerates one immutable state's semantic candidates and issues its decision contract once,
then shares that preparation across choosing and verification. Existing chooser wrappers and
the native driver retain their policy, search budgets, action ordering, RNG, owner/actor checks,
stack-pass classification and apply behavior. Yama adopts this in the lab and diagnostic trace.
Its live-play callers that search a modified state keep separate authority for that state.

Consumer measurement source: Yama `2b78b83a18c22b79c59af18c93e1a854b8d42335`.
Verification image: `sha256:9ab7ff9cadbda234827258cae661d3861e483c4892c7a0bff4df3d33c06f9ebb`.
The baseline image was deployed Yama `2ecdd08`, with Phase `9b2073b` and byte-identical lab game
code to the later market/public-reference releases. This report describes isolated verification
runs, not which image is currently deployed.

## Same-host slow-game replay

The saved four-precon game used seed `3160109258497874`, Sneak Attack, Revival Trance (stock),
Eldrazi Unbound and Symbiotic Swarm. All runs used the same frozen lists and card export
`1e5608e61683de41c84f08f70115bef38db13df85bc5e01fd0eb249cf023244d`.

Host: saget, Intel Core i7-7820X at 3.60 GHz, 8 cores / 16 threads, 32 GiB RAM. Each isolated
container had a one-CPU quota and 3 GiB memory limit. Phase retained its 2 GiB child data limit,
600 CPU-second budget and production native opt-level 2/mimalloc build. Forge 2.0.15 used one
slot, one JVM processor, 1536m heap, Default profile and its existing 900-second wall limit.
Neither limit was reached in this case. The containers had no network, published ports or DB
access. Other server work continued; these were CPU quotas, not dedicated cores.

| Engine | Complete job wall time | CPU time | Sampled peak container memory |
|---|---:|---:|---:|
| Phase baseline | 468.65 s / 451.45 s; mean 460.05 s | 449.45 s on the fully sampled repeat | 763.57 MiB on that repeat |
| Phase candidate | 281.36 s / 289.60 s; mean 285.48 s | 280.10 s / 287.94 s | 924.89 MiB / 821.88 MiB |
| Forge, fresh replay | 738.87 s, one run | 738.42 s | 1056.31 MiB |

The Phase candidate took **38% less complete-job time** (1.61x speedup). Both candidate runs
preserved the entire stored Phase result except timing/build label: winner 1, turn 44, 1,903
actions, placements, eliminations and final life. Anonymous memory at the sampled container peaks was approximately
715-720 MiB versus 563 MiB at the baseline's sampled container peak; record the memory cost
alongside the CPU improvement. Container totals also include variable file-cache charges.

The candidate was **2.59x faster than Forge on this one scheduled game**. Forge chose different
actions and finished with winner 2 at turn 55; this is not an equal-action microbenchmark, AI
quality verdict or workload-wide throughput result. Only one fresh Forge run was measured.
The 2-3x goal across the relevant Commander workload remains open.

The second saved slow game, seed `4287449942630390` (Raining Cats and Dogs, Mirror Mastery,
Lorehold Spirit and Eternal Bargain), still exhausted 600 CPU seconds at turn 72 / 3,905 actions.
Its complete job took 614.88 s; the result remains an **unscored time_cap**, not a completed win.
No speedup is claimed for that case without a matched fresh baseline. Raw requests, profiles,
Docker stats and result logs remain local ignored evidence under `data/engine-recovery/2026-10-27`.

## Validation and limits

- Phase affected AI crate: 2,972 passed, zero failed, 21 ignored, including five new work-count,
  selection/RNG/authority/native-driver regressions and the runnable public API example.
- Independent checkpoint and complete private-PR-head source reviews: zero findings. Full
  format check and parser/architecture gate passed; parser output/card data are unchanged.
- Cross-crate source-census selection: 30 passed, zero failed, including both scans that read
  the changed AI files; 11,956 unrelated integration tests were filtered out.
- Stable Clippy reproduced the prior trait-resolution stall and was interrupted, not passed.
  The installed pinned `nightly-2026-04-19` passed AI all-target lint with `-D warnings`.
- Combined Yama source: 1,485 default Rust tests passed, zero failed, 43 ignored; 499 JavaScript
  tests passed, two skipped; type checking, web build and 17 release-guard tests passed. The
  first combined Rust attempt hit transient ENOSPC before tests; the jobs=1 retry passed.
- The full-workspace-built candidate test harnesses ran the full-data checks directly, preserving
  the production workspace dependency graph: both determinism/restart tests passed, including
  four scenarios run twice and restart at three save points. All selected games finished normally.
- Frozen live regressions remain **one passed, four failed**: both priority-session cases,
  Adventure's empty offer and combat-tax payment are still open. The successful World Shaper
  control retained winner 3 / turn 54 / 2,072 actions. Assertions were not weakened.

The optional repository-wide Yama default-rustfmt check also reports pre-existing formatting
throughout the baseline; unrelated files were not reformatted. No green full-game suite or
general Phase/Forge parity is claimed. Worker process isolation and a healthy HTTP
server do not establish gameplay correctness. See [gameplay validation](gameplay-validation.md)
for the frozen failure cases and ordinary full-data test commands.
