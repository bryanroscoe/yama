# Lab workers on saget, the laptop and GitHub

This is an opt-in, admin-only Phase pilot. Existing experiments keep the built-in saget
worker unless explicitly routed before their first Phase game starts. Forge continues through
its existing separate worker. Nothing here launches a game, GitHub workflow or deployment on install.

Saget retains the database, frozen experiment inputs, scheduling and ratings. Workers make
outbound HTTPS requests, receive only the assigned decks, run credential-free child processes
and upload results. A laptop key accesses only its owner's jobs, including for an admin owner;
it never gains access to other users' jobs. The worker needs no incoming port or database copy.

## Execution choices

- `saget`, `laptop`, `github`: the selected kind of external worker claims the work.
- `auto`: choose among compatible workers online within the last 45 seconds, ready within
  their load/memory limits and not holding a live lease. Prefer measured seconds per game;
  unknown workers start at 120 seconds/game. Only fully scored pods teach throughput; a worker
  returning an unscored pod is excluded from production selection for five minutes. Explicit
  comparisons can still probe it. It chooses at pod boundaries and does not migrate
  a running game. A cold/offline worker is ineligible; **this pilot does not provision Actions jobs**.
- A comparison creates separate copies of 1–10 schedule units for two or three targets.
  Copies never enter deck results, rankings, normal game counts or paired confidence intervals.
  The report compares every game-result field except elapsed milliseconds and the runner policy
  label. Timeouts/errors remain visible differences. It reports per-pod wall time, one-time setup,
  peak game-process RSS, build and lease/completion timestamps. Queue and setup time can therefore
  be distinguished from simulation time. These are measurements, not a GitHub billing statement.

Change/compare experiments lease both halves of a pod together, committing both in one
transaction. Other modes lease one game. Every result must match the game ID, seed, deck order,
difficulty/pilots, engine, card-data hash and the **leased** runner build. macOS and Linux keep
their distinct isolation labels. New executions select the server's current runtime rather than
the experiment's creation-time build. Pending production pods adopt the current runtime after a
deployment as whole units; completed pods keep their recorded build. Comparisons stay on one
selected build and cancel with `runtime_changed` if it becomes unavailable, preserving completed
diagnostics. LLM pilots are excluded from this pilot.

An explicitly routed Phase run requires an external worker even when the chosen target is
saget. The built-in dispatcher excludes it, including a game selected just before routing.
The Forge half of a both-engine experiment retains its normal dispatcher. Routing an already
started Phase run is refused. More-games on routed runs is refused; rerun and route the new
experiment. Ordinary built-in runs retain their existing behavior.
Built-in queue position and ETA exclude externally routed Phase work; use the execution report
for its progress rather than interpreting those jobs as FIFO work ahead of ordinary saget runs.

## Worker API v1

Admins create keys with the existing session-only `/api/me/tokens` endpoint, one of these scopes:
`lab:worker:saget`, `lab:worker:laptop`, `lab:worker:github`. Existing expiry, revocation,
disabled-account and open-signup checks apply. These keys are accepted only by the worker API,
not normal app, MCP, planner or execution-management routes. Sessions cannot call worker routes.
Removing the owner's admin role also disables these pilot credentials.

| Endpoint | Contract |
|---|---|
| `POST /api/lab/executions` | Admin session; `{id: UUID, experiment_id, target, comparison, targets, sample_units, github_minutes}`. UUID retries are idempotent; reusing an ID with different inputs conflicts. Default target `auto`, comparison false, sample 3, GitHub budget 0. |
| `GET /api/lab/executions/{id}` | Owner session only; job progress, measurements and agreement report. |
| `POST /api/lab/executions/{id}/cancel` | Owner session; idempotently cancel pending work and fence leases, retaining completed results. Cancelling a comparison preserves its source experiment; cancelling production also cancels that experiment. |
| `POST /api/lab/executions/{id}/budget` | Admin owner session; `{id: operation UUID, github_minutes: new total}` increases the work allowance. Retried operation IDs are idempotent; conflicting reuse is refused. |
| `GET /api/lab/workers/runtime` | Worker key; protocol, OS/architecture, build and full SHA-256/size of the binary and card export. |
| `GET /api/lab/workers/runtime/binary` | Worker key; running server executable, no configuration/database. Bootstrap only on matching OS/architecture. |
| `GET /api/lab/workers/runtime/card-data` | Worker key; engine export. Verify full SHA-256, not just its filename. |
| `POST /api/lab/workers/claim` | Worker key; `{worker_id: UUID, build: {engine,card_data,runner}, ready: bool, execution_id?: UUID}`. Returns null or `{id,job_id,expires,heartbeat_seconds,requests,build}`. Each request is the existing `lab-game` JSON contract. |
| `POST /api/lab/workers/leases/{id}/heartbeat` | Renew a live lease for 180 seconds, normally every 30 seconds. |
| `POST /api/lab/workers/leases/{id}/results` | `{results: GameResult[], wall_seconds, peak_rss_bytes, setup_seconds}`. Submit every game in the lease in order. Whole-pod validation/commit; identical retries succeed after a lost acknowledgment. Conflicting retries return 409. |
| `POST /api/lab/workers/leases/{id}/release` | Return an unfinished live pod. |

Stopping a queued/running source experiment in the existing Lab UI also makes its dependent
execution reports cancelled (`experiment_cancelled`). Completed results remain available.

A lease belongs to its worker key and worker UUID. Expiry/release fences late uploads even
if another worker has already started the pod. Cancellation invalidates outstanding remote
leases; cancelled or deleted experiments accept no new results. Workers stop their child on
401/409 or after losing heartbeat contact for 150 seconds. Restarting the server does not lose
leases. Client work directories are mode 0700, files 0600. Completed uploads survive connection
failures; a lost acknowledgment retries the exact payload. Stale or partial pods are retained
locally for diagnosis and the complete pod is reassigned. Protect/clean that private directory.

## Setup and commands

Merge/deploy this code through `deploy/RELEASING.md` only when authorized. Build the laptop's
native `yama-server` against `deploy/phase-rev` in a sibling `yama-phase` checkout. Do not change
another thread's engine checkout. `CARGO_BUILD_JOBS=4 cargo build --release -p yama-server`.
The worker checks source identity and the full card-data hash before claiming work. Docker and
native builds both stamp the full Yama commit SHA; build the laptop binary from the deployed
commit. Linux can
bootstrap the matching executable from the running server; macOS needs its own native binary.

The CLI uses Python 3.11+ and only the standard library. Supply token files through the normal
local secret workflow; never put tokens in arguments, source, logs or a checked-in file. An
existing session token can create a target-limited key without printing it:

```sh
python3 tools/lab_worker.py --server https://yama.saget.org --token-file /private/session-token \
  key --target laptop --output /private/laptop-worker-token --days 7

python3 tools/lab_worker.py --server https://yama.saget.org --token-file /private/laptop-worker-token \
  work --binary ./target/release/yama-server --work-dir /private/yama-worker --max-jobs 1
```

The card export is downloaded and checked automatically unless `--card-data PATH` is given.
Use `--execution UUID` to restrict a worker to one comparison or production execution.
Defaults: one pod, stop after 60 idle seconds, at least 2560 MiB free/reclaimable memory, and
one-minute load below 75% of logical CPU count. `--continuous` opts into a foreground worker
until stopped. `--max-load` and `--min-free-mb` set headroom; workers run one game at a time.
The parent also samples child RSS every two seconds, stopping a game above `--max-game-mb`
(2048 by default). This extra policy is recorded in the runner label. The macOS child has process
isolation/deadline and this sampled RSS guard, rather than Linux's immediate heap enforcement;
keep the platform labels and measure it separately. Interrupting the worker stops its child; the pod's
lease expires and is reassigned. HTTPS redirects are refused. `--allow-http` explicitly enables
plain HTTP for local fixture tests, not production.

Route an untouched queued experiment, using a persisted UUID for safe retries:

```sh
python3 tools/lab_worker.py --server https://yama.saget.org --token-file /private/session-token \
  execution --id UUID --experiment EXPERIMENT_UUID --target auto

python3 tools/lab_worker.py --server https://yama.saget.org --token-file /private/session-token \
  execution --id DIFFERENT_UUID --experiment EXPERIMENT_UUID \
  --compare saget laptop --sample-units 3

python3 tools/lab_worker.py --server https://yama.saget.org --token-file /private/session-token \
  report EXECUTION_UUID
```

Routing needs to happen before the built-in Phase worker claims the run. For the first pilot,
select an already queued experiment, pause built-in Phase execution with `YAMA_LAB_THREADS=0`,
route that experiment and start the explicit worker. New experiments cannot be created while
built-in execution is paused. Preserve the operator's previous pause/resume setting. A comparison
of a finished run uses its frozen inputs and the current runtime without changing its execution route.

## GitHub pilot and costs

The checked-in workflow is `workflow_dispatch` only: no push, PR or scheduled trigger. After
publishing is authorized, configure a `lab:worker:github` key as `YAMA_LAB_WORKER_TOKEN` in the
private repository's Actions secrets, and optionally the `YAMA_URL` variable. Dispatch manually
(optionally restricting the `execution_id` input to one execution);
the worker downloads and verifies the running Linux executable and matching export, polls for
up to 30 idle seconds and executes one leased pod. Timeout is 100 minutes, concurrency one.
This avoids rebuilding the large engine on every Actions runner. The script and workflow must
be from a trusted branch. A runner teardown loses its local spool; missing acknowledgments are
still deduplicated server-side, and unfinished pods return after lease expiry.

An explicit GitHub execution/comparison is rejected unless its allowance covers every selected
GitHub job; the 400 response names `required_github_minutes`. Auto can use a partial GitHub
allowance and other available targets. Each leased
pod permanently reserves its full outer game deadlines plus two minutes for setup; expiry and
retries reserve again, conservatively. Increase an exhausted allowance with
`budget EXECUTION_UUID --minutes NEW_TOTAL --op-id OPERATION_UUID` on the same CLI, preserving
the run and its results. **This is a work admission budget, not an account spending
cap:** runner startup, waiting, downloads and storage can still be billed even if no work is
claimed. Configure GitHub's account spending controls independently and measure an explicitly
approved pilot before automating dispatch. The workflow uploads no private deck artifacts.

## Validation

`python3 -m unittest discover -s tools -p 'test_*.py'` covers lost acknowledgments, private spool
files, stale results, capacity guards and credential-free children. Rust `lab::remote` tests
exercise migrations, paired atomic uploads, schedule/build validation, lease expiry/reassignment,
owner isolation, scope/revocation, routing races, budget admission and diagnostic comparisons.
Use a small matched sample on the actual machines before claiming performance equivalence.

Validation after PR review and integration with main on 27 October 2026: full `cargo test`
passed 1,540 tests with 44 ignored; `npm test` passed 509 with 7 skipped; typecheck, web build,
all 7 Python tests, all 18 release-guard tests and `actionlint` passed. The 21 Rust worker tests
include regressions for stale runtime adoption, comparison cancellation, failure health,
lease fencing, startup readiness, Stop propagation and queue scans beyond 100 ineligible jobs.
The real build script is tested in
native-git and git-less export contexts for matching clean and dirty full-revision identities,
including changes confined to the server. A guarded deployment regression verifies that the
full release revision reaches the Docker build.

Rust validation used the current private Phase pin `8aff83e`. To reuse the existing engine
cache, validation temporarily redirected engine dependency paths to an archive whose engine
sources/manifests matched that pin byte for byte; the current pinned AI/LLM sources were compiled.
All manifest paths were restored afterward. No Phase source, pin or lockfile changes are included.
No production deployment, Actions dispatch or cross-machine performance witness was performed.
