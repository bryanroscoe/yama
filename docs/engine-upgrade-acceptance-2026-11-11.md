# Engine upgrade acceptance, 11 November 2026

Status: the parser-matched card export passes schema and integrity validation.
Native engine/AI/LLM suites passed as detailed below. Yama library tests passed
(1,129 passed, 35 ignored), and all five seeded games finished normally without
engine errors. Final-head release checks remain separate from this local evidence. No production
engine switch has occurred.

The candidate rebases Yama's custom stack onto upstream
`c53dd8a81af2354a14e811a806670c21585a7c06` (v0.122.0). The exact fork commit is
in `deploy/phase-rev`. Input metadata is MTGJSON 5.3.0+20261111; AtomicCards,
Meta, CardTypes, SetList and all 345 token-bearing set files were refreshed on
11 November. [Input and export provenance](engine-data-2026-11-11.json) records
the source hashes and the 102,326,733-byte export,
`card-data-19b30ee31fc29d11.json`, SHA-256
`19b30ee31fc29d11df4edfb02ecc9543c4facb17c635b17dfd5347c81462a630`.
The matching CLI validator loaded 36,280 indexed faces and passed export integrity.
The current deck-card test slice adds the two required Prepare spell faces from
this export; its original 810 entries are unchanged.

## Gameplay acceptance

The original five input fixtures retain their decks, seats, shuffle seeds,
difficulty and limits. The v0.119 metadata remains unchanged. The new
`candidate-v0122.json` has a separate card-data hash and control expectation;
its export hash and investigated control (winner 0, turn 66, 3,178 actions)
are recorded. No-error normal Win or Draw remains required. Repeating an engine
error does not establish gameplay acceptance.

The original control is winner 3, turn 54, 2,072 actions. The previous candidate's
separate control is winner 3, turn 44, 1,754 actions. A changed v0.122 result must
be investigated before establishing its own expectation. Neither historical
expectation is rewritten to match the new engine.

The [control investigation](engine-control-2026-11-12.json) found all 284 distinct
fixture cards in both exports, with unchanged Oracle text. Running the current
v0.122 engine on v0.119 data gives winner 0, turn 52, 2,424 actions; that diagnostic
is not a replay of the historical engine. The old-data and current-data traces
first diverge on turn 40, when the newly typed Leyline Tyrant optional payment
adds an accept/X/target decision. The current-data trace independently reproduces
winner 0, turn 66, 3,178 actions, with no error, stall or cap. This identifies a
data-driven divergence without attributing every later difference to one card.

Run the new suite on verified data, one test at a time:

```sh
CARGO_BUILD_JOBS=1 YAMA_ENGINE_CARD_DATA=/absolute/path/to/verified-current-data.json \
  cargo test -p yama-play --test integration candidate_v0122 -- --ignored --nocapture --test-threads=1
```

The suite checks the compiled runner against the checkout, the Phase pin against
its versioned provenance and the data bytes against the compiled SHA-256. The
result lines record the full engine/data/runner identities.

## Retained v0.119 games

The frozen worker uses Yama `4146a91a1c51c9374e8969954964c4f8c92759d1`, Phase
`19be58d497a6618b34c0862ca1d27c8c48999480` and card data
`cbd552b41f962f5b80839d35196cfc9621df2406ef3886ca23db8e2f743be505`.
The reviewed export is bound by `runtime/v0119/historical-source.json`.

The guarded macOS rebuild completed with source binding
`281cec4ad4acd280f12e0c8da90143e0b7069d04b07e45467b97289f17f5c381`
and binary SHA-256
`fbbc3b9d0af84fe3066fcf165cae080ca712880371e251c935e7200e82fc2228`.
Seven tests on this real worker passed: exact
source/data preflight with corrupt-data rejection; legacy logged Full Control
recovery; stops/payment/temporary-hold preservation; explicit preference changes;
a real Keep choice followed by Go back and process recovery of its rewind audit;
solo abandonment surviving process recovery without a winner; and recovered
knockout/concession result metadata. Live rewind
checkpoints remain process-local. These tests use synthetic public-card fixtures.

The newer-main result-persistence integration subsequently extended the worker
with public knockout facts and a win condition, reusing the separately pinned
Yama result mapper. Its source export was independently reproduced, and the rebuilt worker passed
the seven native tests above. The server persistence and result-fact regressions
also passed in the reconciled workspace suite.

The server's real frozen-runtime integration test passed on 12 November, including
private participant and spectator views, accepted normal continuation, final-board
recovery, identity/original-replay fences and corrupt-data rejection. It explicitly
checks that live rewind checkpoints are process-local while all other continued
view fields survive reopening. The existing v0.113 worker and source binding are unchanged.

## Other evidence

Phase client: 689 test files and 11,380 tests passed, with two files and one test
skipped and 12 todo; coverage thresholds and TypeScript checking passed. Codex
review completed without findings on `6b9c9e6b0b9876cf2c36e291287799d024be2e8b`.
The reconnect finding was reproduced for writable and read-only attachments and
fixed before that review. Native Phase engine/AI/LLM test targets compile on
`89e036b3a69156282401737f4fcf35785aa0fa65` after three compatibility fixes.
Native AST tests passed (505); parser tests passed on
`c7fa78d9be700e0b547510f13f556050055b685d` (12,348 passed, three ignored).
Codex cloud review completed without findings on that same head.

The final compatibility commit is `e19d8e657dccd80e5e6ca9128ac67eadbc5b0b05`.
Its exact tree passed engine library tests (13,852 passed, four ignored),
integration shard 2 (3,161 passed, one ignored) and LLM tests (209 passed).
Independent and cloud review of that committed correction found no defects. Unaffected c7 results passed: AI library 3,188
(ten ignored) plus its integration/CLI targets; engine integration shards
1/3/4/5 passed 3,027 (three ignored), 3,261, 3,090 and 3,205 (eight ignored),
plus six engine CLI unit targets. The generator actually ran at c7; the final
commit changes no generator, parser or engine production source.

The referee adapter now uses the canonical current filtered target domain for
both scripted validation and automatic selection, including an empty domain.
All 20 compiled scenarios completed without engine errors. Nineteen final states
match Forge exactly. In `blood-moon-urborg-c4`, both destroy Blood Moon and restore
the land types; Phase taps Plains plus Island and Forge taps Plains plus Urborg
for Disenchant. All other state matches. The raw comparison remains 19/20 with
exit 1; the alternative mana payment is recorded separately, not hidden by changing
the comparer. The full export passed schema and integrity validation above.

The reviewed deployment host support is installed as root, mode 0700, with SHA-256
`d6b1b313c66d06398ef6983d11314c02b25550d8ef63cd98f24a92e499023071`.
The reconciled host suite passed 91 tests. Installation alone does not verify the new Linux image,
its three data artifacts or production behavior; those remain release gates.


## Published source and hosted checks

Phase PR6 published e19 after preserving old main under the archive tag.
Follow-up PR12 retained the immutable protocol record, removed an orphaned doc
paragraph and restricted upstream bucket publishing to upstream. Its final head
`38bc36ee63209291f8ad7ca258fd8db8a11a8e8e` passed required hosted checks, including
all five Rust shards, Clippy/parser gate, frontend, card generation/validation,
WASM and the AI/performance gates. Five optional checks were skipped. Cloud
review completed with no findings; independent reviews covered the substantive
protocol and workflow changes. The published merge is
`273ad56c8afdc15fd0fcff9f44f47816504f997f`, with the same tree as that reviewed head.
Yama pins this merge. These source checks are separate from the Yama seeded
control and frozen-runtime server evidence above. The actual full export was generated
on c7, as its provenance continues to record.
