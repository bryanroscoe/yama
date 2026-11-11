# GitHub test CI

## Tests on or off

**Off since 2 Nov 2026 (Bryan).** The plan includes 3,000 hosted Actions minutes a month and
CI used 2,715 of them in the first two days of November: about 2,600 minutes in 208 runs of
each CI job. The Rust job alone took 2,233 of those minutes, the gate 193 and the web checks
182. At that rate a month needs roughly 40,000 minutes, about 13 times the allowance.

The repository Actions variable `CI_TESTS` is the switch:

```sh
gh variable get CI_TESTS                 # off unless it says exactly "on"
gh variable set CI_TESTS --body on       # tests back on
gh variable set CI_TESTS --body off      # tests off
```

No workflow edit is needed; the next run reads it. Any value but `on`, including an unset
variable, means off:

- PR runs and main-push runs start no gate, web or Rust job, so they use no runner time.
  Automatic Android PR builds (`android.yml`) are off too.
- A push to main runs one job, **Tests are off (checked locally before merge)**. It runs no
  checks. It exists because the deploy workflow and saget's release gate (`deploy/host.py`)
  both require a *successful* push CI run, and a run whose jobs are all skipped concludes
  "skipped". It runs where `CI_LINUX_RUNNER` points: free on saget (where it waits for CI
  capacity like any job), about one billed minute per main push on a hosted runner. It was
  meant for saget, but on 2 Nov 2026 saget's CI hook rejected every job ("Invalid CI pool
  capacity": sagetserver's `ci/hooks/slot.py` still requires the old 12 GiB pool after the
  pool grew to 20 GiB), so it runs hosted until saget CI is fixed and routed back.
- A manual run (`gh workflow run CI --ref <branch>`, or an Android build from the Actions tab)
  still tests or builds in full on the runner `CI_LINUX_RUNNER` picks. Start one only when
  Bryan asks.

With tests off, agents run the checks before merging: `CARGO_BUILD_JOBS=1
scripts/local-ci.sh --no-amend` on the final head after reconciling with main, then the local
results go in the PR as local evidence (AGENTS.md). `local-ci.sh` doesn't build the Android
app, so a change under the paths `android.yml` watches (`web/android/**`,
`web/capacitor.config.ts`, `web/src/native.ts`, `web/package.json`) also runs that build
locally with JDK 21 and the Android SDK (docs/mobile.md):

```sh
npm run android:sync -w web
(cd web/android && ./gradlew --no-daemon assembleDebug bundleRelease)
``` The caveats in
[Don't test a merge twice](#dont-test-a-merge-twice) about macOS vs Linux apply to every merge
while tests are off, since nothing re-tests main on Linux.

To get free CI tests back without paying for minutes, set `CI_TESTS` to `on` and route CI to
saget (`python3 scripts/ci_runners.py switch saget --repo yama --apply` from `sagetserver`;
see [Choose the CI backend](#choose-the-ci-backend)). Saget jobs cost no Actions minutes but
share saget's CI pool.

The rest of this page describes CI with tests on.

While tests are off and several threads are landing work, one coordinator runs this gate once per
batch instead of every thread running it per PR: see [release trains](release-trains.md). Trains
stop when tests are switched on again.

## How it runs

`.github/workflows/ci.yml` runs on ready pull requests into `main`, pushes to `main`, and manual
dispatch. There are no path filters: documentation and workflow changes also receive checks.
Draft PRs skip every job. Ready PRs skip the web and Rust jobs when their head commit passed
the same checks locally on its exact tree and contains `main`, or when they carry the
`skip-ci` label; see [Skip CI on a PR](#skip-ci-on-a-pr).
A newer push to a PR cancels its superseded run. Push CI on main is never cancelled: one main run finishes while only the newest push waits behind it, so main CI completes, deploys and saves the Rust cache. Manual diagnostic CI uses
a separate concurrency group and cannot cancel the push CI required for deployment. Only
successful push CI on a main commit authorizes release, while that commit stays on main; a
newer commit passing CI no longer cancels it. Production never goes back to an older commit. CI runs on GitHub-hosted Linux (`CI_LINUX_RUNNER` unset, or `["ubuntu-latest"]`; the
workflow default), free since the repository went public in November 2026. **Never register a
self-hosted runner on this repository**: on a public repository a fork pull request can rewrite
a workflow and target any runner label, and workflow job guards alone can be changed by a PR.
Every job that could reach one starts with a step that fails on a self-hosted runner of a public
repository, as a tripwire for a misconfiguration, not a boundary. From 2026-10-29 to the move,
CI ran on two saget listeners (`saget-yama-ci`, `saget-yama-ci-2`) for the then-private
repository, now the private `bryanroscoe/yama-archive`; they are retired with its Actions.
Deploys use the Cloudflare backend in
[deploy/RUNNER.md](../deploy/RUNNER.md#choose-the-deploy-backend).

- **Web checks:** preinstalled Node 22 (the production web build's major), `npm ci`,
  `npm test`, `npm run typecheck`, and `npm run build`.
- **Rust and Python tests:** preinstalled Rust 1.98.1, `cargo test --locked` with four build
  jobs and low debug information, release/host guards, portable worker/build identity,
  commander evidence/list validation (also under Python optimization), and dataset recovery.
  Resource usage, process timing and tested Yama/Phase revisions are recorded. Each saget
  runner has four CPUs and a 12 GiB memory limit inside the shared CI pool (eight CPUs, 20 GiB;
  Bryan, 2026-11-02), so both Yama listeners can run a Rust job at once; jobs cannot change
  host swap or use sudo. The pool lives in sagetserver's `ci/` fleet controller.

`deploy/ci-runner/` defines the pinned official runner/toolchain image, startup, Compose
limits and a completion hook. Its server directory is `/mnt/user/appdata/yama-ci-runner`.
The `state` and `cache` directories belong to UID/GID 1001. `/ci-cache/cargo` holds registry
and Git dependencies, `/ci-cache/target` holds one dev/test build profile, and `/ci-cache/npm`
holds npm downloads. These are distinct from production/BuildKit caches. Saget jobs use no
Actions cache; a passing PR Rust job uploads only the tiny passed-tree artifact. The completion hook removes the job checkout (including
`node_modules`, web build output and temporary Phase checkout) and job temporary files after
post-actions. It retains the single warm compiler/dependency cache to avoid repeated cold builds.
Check cache size after the first run and during maintenance; investigate growth beyond the
single workspace profile before retaining more. Stop the runner before any scoped cache cleanup.

## Choose the CI backend

Both jobs select the JSON labels in the repository Actions variable
`CI_LINUX_RUNNER`. An unset variable keeps the current saget default. The
`sagetserver` control CLI changes routing without a workflow edit:

```sh
python3 scripts/ci_runners.py switch saget --repo yama --apply
python3 scripts/ci_runners.py switch github --repo yama --apply
```

Run these commands from the `sagetserver` repository. Omit `--apply` to preview;
`--all` selects every configured private project. The values are
`["self-hosted","Linux","X64","yama-ci"]` and `["ubuntu-24.04"]` respectively.
Newly scheduled jobs use the selected backend. Existing jobs finish on their
assigned runner. GitHub-hosted private CI needs available account minutes/billing;
changing the variable does not clear a billing block.

Since 1 November 2026 yama routes to GitHub-hosted runners (`["ubuntu-24.04"]`);
switch back to saget only when hosted jobs can't run (billing), and back again after.
Hosted jobs install Node 22 and Rust 1.98.1, with eight GiB of swap on their
one-use VM for the engine compiler. They restore npm downloads and the Rust build
(dependencies and the pinned engine, keyed by `deploy/phase-rev` and the Rust version) from
the Actions cache. Only push CI on main saves the Rust cache, so a PR reuses main's warm build
and never evicts it. A warm build compiles only Yama's own crates (a few minutes); a
change to `deploy/phase-rev` compiles the engine again (about 25 minutes) until main saves it.
The engine checkout's files are dated to its commit first, because Cargo
rebuilds a path dependency whose files look newer than its cached build. Yama is checked
out as `app`, not `yama`: rust-cache saves dependency builds only from paths outside the
workspace root, and `yama-phase` begins with `yama`, so the engine was silently dropped from
every saved cache. rust-cache's key hashes every installed toolchain, so hosted jobs uninstall
the image's own toolchains first; otherwise each image update missed the cache. Its key also
covers `CARGO_*`/`RUST*` settings, manifests and `Cargo.lock`; a workflow change makes main
test in full, so it saves under the new key. Hosted Rust jobs also
delete unused preinstalled toolsets (.NET, Android, GHC, CodeQL) because the image leaves
about 4 GiB free. Play's integration tests (`play/tests/*.rs`) build as one binary, `integration`
(`tests/integration.rs` lists each file as a module), because every test binary links the
whole engine; run one file's tests with a filter, such as
`cargo test -p yama-play --test integration determinism::`. `cargo test` runs with `--timings`; the **Show where Rust build time
went** step prints the slowest compile units (then deletes the report, so saget's cache
doesn't grow). Tools in `play/src/bin` without unit tests set `test = false`, so CI doesn't
build and link a second copy of each against the engine; give a tool `test = true` when it
gains tests. Saget uses its preinstalled tools and persistent
cache, with no sudo or host swap changes. Tests and deployment authorization are
identical on both backends. The local job budget includes time waiting for the
shared compute slot; hosted job budgets retain their previous limits.

## Manage saget workers

The shared controller in `bryanroscoe/sagetserver` owns registration, immutable
profile images, restart reconciliation and resource budgets. Its runbook is
`ci/README.md`; use `scripts/ci_runners.py register --repo yama --wait` there.
Do not start a second standalone worker from the legacy Compose example while
the fleet controller owns this worker. Its state/cache stay at
`/mnt/user/appdata/yama-ci-runner`; the deployment runner remains separate.

Pooled CI has an aggregate eight-CPU/20-GiB limit (four CPUs and 12 GiB per worker; Bryan,
2026-11-02) and two execution slots, with
root-selected memory reservations. It shares Yama's host release gate; production
takes that gate exclusively. Each repository has separate state, cache and network.
Only read-only hooks, nonsecret settings and empty coordination locks are
added to the original CI mounts. The controller restarts stopped workers after
reboot and never recreates running workers or changes production containers.

Verify runner name/labels, mounts, limits and real GitHub jobs after changes.
Image IDs are immutable; refresh tools/OS packages through reviewed profile
changes. If CI is compromised, stop this worker and rotate its registration and
read-only Phase key before rebuilding its state/cache.

Rust CI checks out Yama and the public `bryanroscoe/yama-phase` side by side, at the exact
40-character revision in `deploy/phase-rev`. It uses the real Cargo manifests and lockfile;
no local cache path substitutions are used on GitHub. The expected engine repository is
checked before checkout. An invalid pin fails the job explicitly.

Yama's own repository is public (AGENTS.md) and must never get a self-hosted runner: CI
runs on GitHub-hosted runners (`CI_LINUX_RUNNER` set to `["ubuntu-latest"]`). Phase has been public since 31 October 2026, so its checkout no longer needs the legacy
`YAMA_PHASE_DEPLOY_KEY` secret. Both checkouts disable credential persistence. Both jobs
refuse fork PRs before scheduling on the persistent runner. Copy reviewed fork work into a
trusted branch in this repository before running CI; skipped fork jobs are not passing
acceptance evidence.

Before merge, inspect the checks on the actual PR head and require both jobs to pass, or a
**Local CI gate** summary saying they were skipped for that head commit. Keep
local validation, GitHub CI, source review, merge and deployment as distinct evidence. The repository
was private on a plan without protected-branch required checks until it went public in
November 2026; the completion workflow enforces this gate either way.

Default `cargo test` deliberately skips ignored full-data gameplay tests. CI does not claim
full-game correctness or cross-machine performance from those passing checks; follow
[gameplay validation](gameplay-validation.md) for that separate acceptance. The manual
[lab worker workflow](lab-workers.md) runs leased simulations and remains separate from CI.

On saget, the first workflow step waits for CI capacity before checkout. The pre-job hook returns promptly so GitHub can report and cancel queued work. This step runs from RUNNER_TEMP, which exists before checkout, and verifies the runner supports the step-slot protocol. Install/adopt the reviewed sagetserver hooks before running these adapters. Hosted jobs skip this step.

## Skip CI on a PR

GitHub-hosted minutes are paid, so PR CI runs only when it adds something. Push CI on `main`
ignores trailers and labels, and the successful push run is what authorizes deployment. It
skips its web and Rust jobs only when a PR run already passed both on the identical tree (see
[Don't test a merge twice](#dont-test-a-merge-twice)); manual runs are never skipped.

**When not to wait (Bryan, 1 Nov 2026).** If PR CI is backed up (jobs still queued after 10
minutes), GitHub is out of minutes or blocks hosted jobs on billing, or a run has taken more
than 30 minutes, don't wait for it. Run the checks locally, treat that as good enough, run
`scripts/ci/skip.sh`, and merge. Local results are the evidence; say so in the PR.

- **Drafts run no jobs.** Open work-in-progress PRs as drafts (`gh pr create --draft`). The
  workflow still starts for each push, but every job is skipped, so it uses no runner time.
  Marking the PR ready (`gh pr ready`) runs CI; later pushes run it as usual. Converting it
  back to draft (`gh pr ready --undo`) cancels CI still in progress.
- **Local checks.** On a clean worktree with Rust 1.98.1 and `../yama-phase` at the published
  commit in `deploy/phase-rev` (checked with `deploy/check-phase.sh`), run `scripts/local-ci.sh`.
  It runs every CI check (`npm ci`, `npm test`, `npm run typecheck`, `npm run build`,
  `cargo test --locked` and the Python suites). Only if all pass does it amend HEAD's message
  with `Local-CI: passed tree=<HEAD's tree> on <os>/<arch> node<major>`; the content doesn't
  change. Push the commit (with `--force-with-lease` if it was already pushed). The **Local CI
  gate** job then skips the web and Rust jobs when the trailer, in the head commit's last
  paragraph, names that commit's own tree and the branch already contains `main`, so the merge
  CI would test is that same tree. A later commit without its own trailer, or a branch behind
  `main`, runs CI again; the gate's step summary says which. Rebase or merge `main`, then run
  the script again to skip once more. `--no-amend` runs the checks without recording anything.
  The trailer is a statement that the checks passed: never write it by hand.
- **One shared Cargo target for local checks** (Bryan, 8 Nov 2026: the laptop can't take a
  20-minute, 7–9 GiB engine compile per worktree). `local-ci.sh` builds into
  `~/Library/Caches/yama/cargo-target` (override with `YAMA_CARGO_TARGET_DIR`; a
  `CARGO_TARGET_DIR` you set wins), not the worktree's `target/`. Every T3 worktree reaches
  the engine through the same `../yama-phase` path, so Cargo compiles the Phase crates and
  every crates.io dependency once and reuses them. Cargo names the workspace's own crates by
  their path inside the worktree, so every worktree's `yama-server` and `yama-play` share
  artifact names there and are judged fresh by file times: `local-ci.sh` therefore cleans and
  rebuilds just those two crates on every run, under a lock
  (`.yama-local-ci.lock` in the target) that queues a second run until the first finishes.
  For an ad hoc Rust test in a worktree, use `scripts/local-ci.sh --no-amend`, or keep the
  worktree's own `target/` and clean it when done; pointing a bare `cargo test` at the shared
  target can run another worktree's server build. The shared target is a machine cache owned
  by Yama local CI, not by any one task, so retiring a worktree leaves it in place. To reclaim
  space, preview and apply
  `agent-clean <worktree> --target-dir ~/Library/Caches/yama/cargo-target` (workspace
  artifacts only, keeping the shared dependency builds) when nothing is running there; add
  `--all` only when the engine pin or toolchain changed and the old builds are useless.
- **Web-only changes skip Rust locally too.** When every file the branch changes since its
  merge base with `main` is web-only by the gate's rule above (`rust_needed`), `local-ci.sh`
  runs the web checks and skips the Rust and Python suites, as PR CI would. `--full` runs
  them anyway. Unknown changes (no fetch, no merge base) run everything.
- **Web-only PRs skip Rust.** When every changed file is under `web/` or `packages/` (or is
  the root `package.json`/`package-lock.json`), the gate skips the Rust and Python job. Files
  the server compiles in (`web/public/`, any `.css` or `.html`) still run it, as does any
  failure to list the PR's files.
- **Queued or slow CI: `scripts/ci/skip.sh <pr> "<what you ran>"`.** After running the
  checks locally (`cargo test`, `npm test` and `npm run typecheck` at least for what your change
  touches; `scripts/local-ci.sh` for all of them),
  this labels the PR `skip-ci`, cancels its unfinished run, re-runs it so the gate skips the
  jobs within seconds, and records what you ran on the PR. Report it as local evidence, not
  GitHub CI.
- **`skip-ci` label.** A PR labelled `skip-ci` skips both jobs at its next push, ready
  transition or re-run (labels are read when the gate runs; adding a label starts no run). Use it
  for documentation-only PRs. To get CI, remove the label and use **Re-run all jobs** (re-running
  only failed jobs doesn't start skipped ones).
- **`[skip ci]` in a commit message** keeps GitHub's built-in behaviour: no CI run starts at all.
  Don't let it reach `main`: a push whose head commit (or a squash merge body) contains it
  starts no CI, so nothing is deployed until a later push to main passes CI. That fails safe,
  but delays the release.

To force full CI on a PR that would skip, run it manually:
`gh workflow run CI --ref <branch>`. The run tests that branch's head and appears on the commit.

## Don't test a merge twice

After every check passes on a PR, the Rust job uploads a small artifact named
`ci-passed-tree-<tree>`: the tree of the merge it tested (PR CI tests the PR merged into main,
not the bare head). When the merge lands, the gate on main's push CI looks up the new commit's
tree. If a PR run with that artifact passed both the **Web checks** and **Rust and Python tests**
jobs (same repository, this workflow), both jobs are skipped, the push run succeeds and the
deploy proceeds. The gate's summary links the run it reused.

The trees match when nothing reached main between the PR's last CI run and its merge (a merge
commit of an up-to-date PR, or a squash with nothing new on main). Otherwise, or when the PR
skipped CI on local checks or skipped the Rust job, main tests in full. Main also tests in
full when the push changes what keys the Rust cache (`Cargo.lock`, a `Cargo.toml`,
`deploy/phase-rev`, `rust-toolchain*`, the CI workflow itself) or `package-lock.json`, because only main's push CI saves
the caches every PR restores. Artifacts are kept for
14 days. Any error reading GitHub runs the jobs.

What a local pass doesn't cover: it usually runs on macOS, not CI's Linux (case-insensitive
paths, BSD tools), may use a Node major other than 22 (recorded in the trailer), and can see
gitignored local files such as `.env` or `data/`. Push CI on main still runs on Linux, so such a
difference shows up after merge as a failed push CI, which blocks deployment until fixed. Prefer
full PR CI for changes that touch the build, toolchain or platform-specific code.

A skipped job is not passing evidence by itself. Report it as local validation (the trailer
names the tree, machine and Node major) and keep GitHub CI, source review, merge and
deployment distinct. The gate fails safe: if it can't read the PR it runs CI, and its own
failure never fails the workflow. It checks out only `scripts/ci/gate.py` from `main` (so a PR
can't change the rule that judges it), needs only `contents: read` and `pull-requests: read`,
uses no secrets and doesn't check out the engine. It runs on the same backend as the other jobs
(`CI_LINUX_RUNNER`), waiting for a saget slot like them.
