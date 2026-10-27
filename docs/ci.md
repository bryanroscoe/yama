# GitHub test CI

`.github/workflows/ci.yml` runs on pull requests into `main`, pushes to `main`, and manual
dispatch. There are no path filters: documentation and workflow changes also receive checks.
Superseded runs for the same PR/ref are cancelled. The jobs use standard GitHub-hosted Ubuntu
24.04 runners and read-only repository permissions; they never contact saget or deploy.

- **Web checks:** Node 22 (the production web build's major), `npm ci`, `npm test`,
  `npm run typecheck`, and `npm run build`.
- **Rust and Python tests:** Rust 1.98.1, `cargo test --locked` with four build jobs and low
  debug information, all release-guard tests, and the portable worker/build-identity tests.
  Cargo dependencies and build output are cached by toolchain, lockfile and engine pin.
  The Rust job adds 4 GiB of temporary swap for cold builds and records resource usage,
  process timing and the tested Yama/Phase revisions. Swap stays on the ephemeral runner.

Rust CI checks out Yama and the private `bryanroscoe/yama-phase` side by side, at the exact
40-character revision in `deploy/phase-rev`. It uses the real Cargo manifests and lockfile;
no local cache path substitutions are used on GitHub. The expected engine repository is
checked before checkout. A missing key or invalid pin fails the job explicitly.

The repository secret `YAMA_PHASE_DEPLOY_KEY` holds a dedicated SSH private key whose public
key is installed as a **read-only deploy key on yama-phase**. It grants no account-wide or
write access. Both checkouts disable credential persistence. To rotate it, install a new
read-only deploy key on yama-phase, replace the Actions secret on Yama, verify a CI run, then
remove the old deploy key. Never put private key material in the repository or logs. Fork PRs
do not receive the secret and need a reviewed branch in this private repository to run Rust CI.

Before merge, inspect the checks on the actual PR head and require both jobs to pass. Keep
local validation, GitHub CI, source review, merge and deployment as distinct evidence. This
private repository's current GitHub plan does not support protected-branch required checks;
the completion workflow enforces this gate without changing the plan or visibility.

Default `cargo test` deliberately skips ignored full-data gameplay tests. CI does not claim
full-game correctness or cross-machine performance from those passing checks; follow
[gameplay validation](gameplay-validation.md) for that separate acceptance. The manual
[lab worker workflow](lab-workers.md) runs leased simulations and remains separate from CI.
