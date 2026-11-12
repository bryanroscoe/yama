# Saved-game runtimes

PR #29 changes the typed card schema and replay semantics. Runtime routing is by the exact
saved identity, before replay parsing. The current engine loads only the data bytes matching
its compiled SHA-256 and `deploy/engine-data.json`; each retained runtime has its own hash.
`historical.json` maps the previously supported `a3bc47c9/cards-1e5608e6` identity to the exact
pre-upgrade Yama adapter and Phase source. The retained Phase commit is reachable through
`archive/pre-sync-20261028`. Its adapter's `ENGINE_VERSION` is checked at worker startup.
Both data hashes were verified locally on 30 October 2026.

One historical process shares its verified card database across server-keyed game sessions.
Commands are serialized through private stdin/stdout pipes. A full 64-request queue returns typed retryable `Busy`; admitted requests have up to 60 seconds to reach dispatch. A queued timeout atomically cancels the request before returning Busy, so it cannot execute later. Active I/O has its own 60-second deadline starting at dispatch; queue backlog cannot be mislabeled as a hung worker. A supervisor can kill/reap the process independently of blocked pipe I/O. Views and matches remain per session. Only a successfully opened session owes a close. Destruction admits that close immediately to a reserved FIFO cleanup lane, ahead of ordinary requests. Each preceding close/active operation has the same bounded I/O deadline, and later traffic cannot starve cleanup; overload never kills unrelated sessions.
The process exits when its last server handle is dropped. Busy keeps live boards/receivers available; commands with replies receive a retry, while safe fire-and-forget commands such as concede are retained for admission. Restart recovery retries Busy and completed-board requests return retryable HTTP503 without permanently caching unavailability. A transport failure invalidates all sessions in that process; the next completed-board request starts a fresh verified child, even if old live handles still exist. Uncertain actions are never automatically resubmitted. Original records remain intact for restart recovery. Provenance, data and replay failures remain fail-closed. An AI gameplay fault instead retains the paused filtered board and command receiver, including concede. It has no
HTTP listener, database handle, or inherited credentials. The authenticated server selects
seats and spectator views, persists accepted continuations, and archives the original saved
record before the first update. Completed boards are reconstructed by the original runtime;
GET requests never overwrite the replay. Unknown identities, missing executables, mismatched
provenance, wrong data bytes and replay failures preserve storage and report unavailability.
Historical boards retain their original wire schema; new Phase types do not parse their actions.

Build locally, sequentially with other Cargo checks (no new worktree or copied target):

```sh
export CARGO_BUILD_JOBS=1
# This destination must not exist. Keep it in the task's artifact manifest.
runtime/build-historical.py /absolute/task-directory/historical-runtime
export YAMA_HISTORICAL_RUNTIME="$PWD/target/debug/historical-runtime"
export YAMA_HISTORICAL_RUNTIME_DIGEST="$PWD/target/debug/historical-runtime.sha256"
export YAMA_HISTORICAL_CARD_DATA="/absolute/path/card-data-1e5608e61683de41.json"
python3 -m unittest discover -s runtime -p 'test_*.py'
cargo test --workspace historical_runtime_continues_live_games -- --ignored --nocapture --test-threads=1
```

The source exporter uses Git objects, never changes either checkout, and refuses an existing
export directory. After the public-history cutover, the original Yama commits remain in
the private `bryanroscoe/yama-archive` repository. A fresh public clone does not contain
them: fetch the archive into an authorized local checkout and pass it with `--yama-repo`.
The primary Mac checkout retains an `archive` remote; the deployment checkout retains
`refs/archive/private-main`. Exporters check all pinned commits before creating output
and report the required source when one is missing. Keep manifest pins unchanged;
rewritten commits are not substitutes for the reviewed historical source.
The exporter adds the transport binary, a byte-verifying data loader, and the
`historical-controls.rs` host-control transport shim to the frozen adapter. The shim
reconstructs logged passing modes and scoped stops without replaying new actions. Account
defaults initialize only missing fields once per seat; explicit changes remain authoritative.
New continuations store a versioned replay sidecar for full control, stops, payment, temporary
hold and passing state. The original replay reducer ignores this transport field. Legacy
logs cannot distinguish a temporary hold from standing Full control, so a logged Full mode
is conservatively retained; unlogged legacy stops and payment use account defaults. Rules,
reducers, AI and card data stay pinned. The exporter uses the current checkout's target serially so common dependency artifacts
can be reused; the old and new engine artifacts remain distinct. Before compiling an existing export, run `python3 runtime/verify-source.py /absolute/task-directory/historical-runtime runtime/historical-source.json`. Prepared exports can
be built with `CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=1 cargo build --locked --manifest-path
/absolute/task-directory/historical-runtime/yama/Cargo.toml -p yama-play-historical --bin historical-runtime`.
The process's `--fixture DATA` mode creates synthetic local opening/completed games for the
integration test; it never reads a database or production game.

**Pinned Yama commits predate the public repository.** `historical.json` pins Yama commits from
before the history rewrite of 2026-11-11, so a fresh clone of the public repository doesn't have
them and `build-historical.py` stops with a message saying so. They are in the private
`bryanroscoe/yama-archive`: add it as a remote and fetch it, or pass `--yama-repo` a clone that
has it. saget's deploy checkout keeps them under `refs/archive/private-main`. Never publish
that history to get them, and never remap the pins: they bind the reviewed source digest.

Production packaging exports both pinned historical repositories and builds the worker in a
separate Docker stage (`historical-source` context). The runtime image contains both binaries.
The default historical data path is the old filename alongside the configured current data.
`YAMA_HISTORICAL_RUNTIME` and `YAMA_HISTORICAL_CARD_DATA` override those locations. Deploying
requires the verified historical file and the updated release host exporter; updating the
repository does not install `deploy/host.py` on saget. This task does not install, deploy, migrate
production records, or abandon games. A missing artifact is a release blocker to resolve by
supplying the pinned artifact, not permission to lose games.

Historical-only baseline reproduction (does not validate the upgrade):

```sh
CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=1 \
  YAMA_ENGINE_CARD_DATA="$YAMA_HISTORICAL_CARD_DATA" \
  cargo test --manifest-path /absolute/task-directory/historical-runtime/yama/Cargo.toml \
  -p yama-play-historical --test lab_regressions -- --ignored --nocapture --test-threads=1
```

The historical expectation remains winner 3 / turn 54 / 2,072 actions. Candidate validation uses
`lab_regressions_candidate` in the current checkout and its separate provenance/expectation.
At the published dd276b0 pin the Adventure-offer, Tricky Terrain priority-session and seed-10
announcement failures remain. The [private feature fixes and acceptance results](../docs/engine-acceptance-fixes-2026-10-30.md)
now pass all five candidate scenarios and the strict debug soak locally. Fork review/merge and
Yama pin/runtime-identity integration are still required; release-mode success never waives a
debug failure.

## Source and executable binding

`historical-source.json` is the versioned expected digest of the exact exported paths
and bytes (including the frozen resolved `historical.lock`, loader shim, and worker).
Only its own generated embedded copy is excluded from the digest to avoid self-reference.
The exporter rejects a differing source tree; the Docker build independently checks the
context against the binding copied from Yama before Cargo runs with `--locked`.
When deliberately changing the transport, prepare a fresh task-owned export with
`--prepare-only --record-source-provenance`, inspect the changes, and commit the binding
with the transport. This flag records evidence; it does not authorize altered historical
engine or adapter semantics.

The Docker builder writes `/usr/local/share/yama/historical-runtime.sha256` in sha256sum
format, naming `/usr/local/bin/historical-runtime`. The server hashes the executable against
that independently produced artifact binding before spawning it, then checks both source
provenance and runtime identity in the greeting. A self-reported identity alone is insufficient.
Local builds write `target/debug/historical-runtime.sha256`; rebuilding a prepared export
manually also requires independently hashing the resulting binary into that sidecar.

`historical-runtime --verify-data PATH` loads and hash-checks the real historical card file,
checks embedded provenance against the adapter identity, emits one bounded JSON success line,
and exits. It opens no database and reads no replay. The host runs this inside the isolated
candidate image after checking the current data and packaged executable digest. Both runtime
and digest overrides require independently verified packaging; the host refuses arbitrary
overrides. Source tests and host mocks do not prove that the image probe actually ran.

Ordinary CI runs the source-provenance tests without building a second engine. The native
preflight and control-recovery tests explicitly skip unless both historical-runtime/data environment variables are
provided. Run the full seven-test command above with the built worker, then the ignored real
recovery test; a source-only CI pass does not stand in for either native or image validation.

The exported Cargo package is `yama-play-historical`, with its Rust library still named
`yama_play`. This keeps frozen/current build-script output distinct in the shared target.
Using the same package name was reproduced overwriting the current runner stamp with the
Git-less export's stamp. Candidate acceptance now requires an exact 40-character Yama revision
and, in a Git checkout, verifies that it matches HEAD before playing any scenario.

## Preserved v0.119 games

The v0.122 upgrade also retains the exact v0.119 adapter at Yama
`4146a91a1c51c9374e8969954964c4f8c92759d1` and Phase
`19be58d497a6618b34c0862ca1d27c8c48999480`, with the original `cbd552b4`
card data. `v0119/historical.json` and `v0119/historical-source.json` bind this
second generation independently. `build-v0119.py OUTPUT --prepare-only` exports
it without the v0.113 loader or controls shim. Its package and executable are
`yama-play-historical-v0119` and `historical-runtime-v0119`.

Both historical generations have separate verified processes and exact identity
routing. The v0.119 worker uses its native replay controls, revision, rewind audit
and abandonment behavior; it supports Go back and End game through the original
board protocol. Solo rewind history remains process-local. New Phase board
messages never cross into a historical runtime.

Production requires both packaged historical binaries and digest sidecars, and
all three data files. Stage the new current export beside the existing files;
retain `card-data-cbd552b41f962f5b.json` and
`card-data-1e5608e61683de41.json`. Install the separately reviewed host exporter
before merging the application upgrade. `YAMA_V0119_RUNTIME`,
`YAMA_V0119_RUNTIME_DIGEST` and `YAMA_V0119_CARD_DATA` are local test overrides;
production's host gate requires the independently verified packaged binaries.

The v0.119 worker also returns public knockout/result facts. Its adapter and
engine stay at their original pins; the engine-independent result mapper comes
from the separately pinned `results_yama` revision in its manifest. That source
file is included in the reviewed export digest. Historical saves use the same
seat-update rules as current games, including clearing a knockout after rewind.
The v0.113 protocol has no such extension and its existing stored facts remain
untouched. New Phase types never interpret the old replay or actions.
