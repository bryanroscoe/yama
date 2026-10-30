# GitHub test CI

`.github/workflows/ci.yml` runs on pull requests into `main`, pushes to `main`, and manual
dispatch. There are no path filters: documentation and workflow changes also receive checks.
Superseded runs for the same event type and PR/ref are cancelled. Manual diagnostic CI uses
a separate concurrency group and cannot cancel the push CI required for deployment. Only
successful push CI on current main authorizes release. Bryan authorized a dedicated CI runner on
saget on 2026-10-29 after GitHub-hosted jobs were blocked by account billing. Both jobs default to
`[self-hosted, Linux, X64, yama-ci]` with read-only repository permissions. The separate
`saget-yama-ci` runner executes one job at a time; it has no deployment credential, Docker
socket, production data/env mounts, or production runner state. Only its own runner state and
dedicated Cargo/npm cache are mounted. This is a persistent runner for this private
repository's trusted branches, not a sandbox for arbitrary untrusted code.
Keep the repository private and its repository-level **Run workflows from fork pull
requests** setting disabled (verified disabled during installation). This server-side
setting is the fork boundary: workflow job guards alone can be changed by a PR.
Recheck it with `gh api repos/bryanroscoe/yama/actions/permissions/fork-pr-workflows-private-repos`
before registering a replacement runner or changing repository access.

- **Web checks:** preinstalled Node 22 (the production web build's major), `npm ci`,
  `npm test`, `npm run typecheck`, and `npm run build`.
- **Rust and Python tests:** preinstalled Rust 1.98.1, `cargo test --locked` with two build
  jobs and low debug information, release/host guards, portable worker/build identity,
  commander evidence/list validation (also under Python optimization), and dataset recovery.
  Resource usage, process timing and tested Yama/Phase revisions are recorded. The runner
  has two CPUs, 12 GiB RAM and no extra swap; jobs cannot change host swap or use sudo.

`deploy/ci-runner/` defines the pinned official runner/toolchain image, startup, Compose
limits and a completion hook. Its server directory is `/mnt/user/appdata/yama-ci-runner`.
The `state` and `cache` directories belong to UID/GID 1001. `/ci-cache/cargo` holds registry
and Git dependencies, `/ci-cache/target` holds one dev/test build profile, and `/ci-cache/npm`
holds npm downloads. These are distinct from production/BuildKit caches. No Actions cache or
artifact service is used. The completion hook removes the job checkout (including
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

Hosted jobs install Node 22 and Rust 1.98.1, with eight GiB of swap on their
one-use VM for the engine compiler. Saget uses its preinstalled tools and persistent
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

Pooled CI has an aggregate two-CPU/12-GiB limit and a whole-job lock shared with
Yama's host release gate. Each repository has separate state, cache and network.
Only read-only hooks, nonsecret settings and the empty coordination lock are
added to the original CI mounts. The controller restarts stopped workers after
reboot and never recreates running workers or changes production containers.

Verify runner name/labels, mounts, limits and real GitHub jobs after changes.
Image IDs are immutable; refresh tools/OS packages through reviewed profile
changes. If CI is compromised, stop this worker and rotate its registration and
read-only Phase key before rebuilding its state/cache.

Rust CI checks out Yama and the private `bryanroscoe/yama-phase` side by side, at the exact
40-character revision in `deploy/phase-rev`. It uses the real Cargo manifests and lockfile;
no local cache path substitutions are used on GitHub. The expected engine repository is
checked before checkout. A missing key or invalid pin fails the job explicitly.

The repository secret `YAMA_PHASE_DEPLOY_KEY` holds a dedicated SSH private key whose public
key is installed as a **read-only deploy key on yama-phase**. It grants no account-wide or
write access. Both checkouts disable credential persistence. To rotate it, install a new
read-only deploy key on yama-phase, replace the Actions secret on Yama, verify a CI run, then
remove the old deploy key. Never put private key material in the repository or logs. Both jobs
refuse fork PRs before scheduling on the persistent runner. Copy reviewed fork work into a
trusted branch in this private repository before running CI; skipped fork jobs are not passing
acceptance evidence.

Before merge, inspect the checks on the actual PR head and require both jobs to pass. Keep
local validation, GitHub CI, source review, merge and deployment as distinct evidence. This
private repository's current GitHub plan does not support protected-branch required checks;
the completion workflow enforces this gate without changing the plan or visibility.

Default `cargo test` deliberately skips ignored full-data gameplay tests. CI does not claim
full-game correctness or cross-machine performance from those passing checks; follow
[gameplay validation](gameplay-validation.md) for that separate acceptance. The manual
[lab worker workflow](lab-workers.md) runs leased simulations and remains separate from CI.
