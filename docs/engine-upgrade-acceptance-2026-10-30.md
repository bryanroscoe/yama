# Engine upgrade acceptance, 30 October 2026

The candidate uses Phase `dd276b0f626c868f43804d0d0cd300d8e7369fbf` and card data
SHA-256 `cbd552b41f962f5b80839d35196cfc9621df2406ef3886ca23db8e2f743be505`.
`lab_regressions_candidate` verifies those bytes and the Phase pin, and emits its exact
compiled Yama runner identity. All five original input fixtures are unchanged from `dc77369`.
The separate config is `play/tests/fixtures/lab-regressions/candidate-v0119.json`.

## Control investigation

The frozen historical adapter/engine/data rebuilt the original control exactly: winner 3,
turn 54, 2,072 actions. The candidate finishes normally at winner 3, turn 44, 1,754 actions.
Both use the original decks, seats, seed 16117943164302123191, Easy difficulty and limits.
The historical tuple remains the original suite's expectation; only the candidate has the new tuple.

Comparing full `labtrace --all-log` runs, the first different gameplay choice is the 143rd
non-pass action, on turn 36. (The new trace's added `payment_mode: Auto` field is a schema
format difference, ignored for this comparison.) Historically Lathliss, Dragon Queen attacks
seat 0. The candidate attacks Gideon Jura instead, removes its six loyalty counters and sends
it to the graveyard. The old game consequently activates Gideon on turn 37; the new one cannot.
Later attacks and draws diverge, and the candidate ends ten turns earlier.

The exported definitions of Gideon Jura, Lathliss, Angler Turtle, Scourge of the Throne and
Isperia are byte-equivalent JSON values across the two data files. Phase commit
`ec4b4fa1ba378e84e44bc883d7d3c0094df99748` (#10304), present in the candidate, explicitly adds
AI redirection toward a killable planeswalker when not racing. The observed first divergence
matches that policy change. This supports a separate candidate control expectation; it is
not a claim that the historical game can be replayed on the new engine or that every later
change has been independently attributed.

## Required scenario outcomes

The candidate tests continue to require `Win` or `Draw` with no error. They do not accept the
following failures as success:

| Scenario | Candidate debug outcome | Winner / turn / actions |
|---|---|---|
| World Shaper control | Normal win | 3 / 44 / 1754 |
| Lorehold priority session | Normal win | 3 / 46 / 2122 |
| Multiverse combat tax | Normal win | 2 / 55 / 2405 |
| Multiverse Adventure offer | **Error**: no engine-issued face choice | — / 10 / 324 |
| Tricky Terrain priority session | **Error**: retained stack-session rejection | — / 41 / 1911 |

The Adventure trace casts Murderous Rider after playing Fetid Heath, Darkwater Catacombs,
and Swamp. Phase then exposes a `CastOffer::Adventure` with zero issued candidates. The
priority trace eliminates seat 1 on turn 41, resolves Valgavoth's counter/draw trigger, then
rejects seat 1's `PassPriority` with “AI priority pass cannot replace the active stack-resolution
session.” Both remain engine blockers requiring fixes and reruns with the same frozen inputs.
The focused priority-session, Adventure-choice, and combat-tax board witnesses cover specific
legal paths; passing those does not supersede these full-game failures.

The prior seed-10 debug soak failure at `announcement_triggers.rs:336` (upstream #10359) also
remains unresolved and unwaived. Historical release soak success is not a substitute.

Run the current candidate suite locally (the command exits nonzero while these defects remain):

```sh
CARGO_BUILD_JOBS=1 YAMA_ENGINE_CARD_DATA="$PWD/data/engine/card-data-cbd552b41f962f5b.json" \
  cargo test --workspace candidate_v0119 -- --ignored --nocapture --test-threads=1
```

Local trace evidence is retained under `.agent-tasks/engine-switch-20261029/compat-control-*`,
`compat-adventure-trace.log`, and `compat-priority-trace.log`. These traces contain synthetic
runs from the repository's frozen inputs, not production replay contents.

## Validation provenance

The final candidate run emitted Yama runner
`b2af015596696463b5e71a213aba5e72ed57eb52-dirty-19829294` and the pinned Phase/data labels
above. It reproduced all five outcomes in the table: three passed, two failed, exit 101.
The working tree was then committed unchanged in executable code. Required workspace tests
passed: 1,642 passed, zero failed, 52 ignored. These default ignored counts include full-data
acceptance tests, which were run separately and reported separately. Web tests passed
(668 passed, nine skipped), TypeScript checking passed, and deployment host/release tests
passed (35 and 20). No compiler guard cutoff occurred.

The historical executable and real full-data synthetic integration test were run locally.
They demonstrate continuation, restart, correct completed boards, per-viewer privacy, shared
process session isolation, original-record retention and unchanged storage on rejection.
No production game content was read. Linux Docker image build and deployment remain untested
by this implementation task; packaging and artifact installation still need release validation.
