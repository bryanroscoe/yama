# Production deployment runner

Bryan authorized this setup on 2026-10-28. Successful **push CI on current main** now
requests an automatic production release. Feature PRs still need review and passing
checks before merge. Merging main is consequently a production release decision.
Pause deployments by stopping `yama-deploy-runner` on saget; CI and PRs keep working.

## Ownership and access

- `.github/workflows/deploy.yml` runs after successful `CI` for a main push, or manually
  on main. It uses read-only Actions/contents permissions and a short-lived token.
- The dedicated `saget-yama-production` runner is a Linux container on saget. Its only
  mounts are its own state and a read-only SSH directory. No Docker socket, production
  data, application env files, or server Git credentials are mounted in the runner.
- Its SSH key has `restrict,command="/usr/local/bin/python3 /mnt/user/appdata/yama-release/host.py"`
  in root's authorized keys. The host validates the complete original command; only
  `host.py deploy|check FULL_SHA` is accepted. No shell, SCP, forwarding, or PTY is allowed.
- The host entrypoint lives outside runner-writable paths. It checks GitHub itself:
  exact current main, latest push CI for that SHA, the CI workflow identity, success,
  branch, event and source repository. A PR job cannot grant itself deployment access
  merely by selecting the runner label. Keep ordinary CI on GitHub-hosted machines.
- Yama Git/API access uses the request's ephemeral token, only in memory/per-process
  git configuration. Phase uses a separate server-only read-only deploy key. Tokens
  never enter Docker contexts, application environments, logs, or command arguments.

## Server layout

`/mnt/user/appdata/yama-release` (root-owned, mode 0700) contains:

- `host.py`: the installed, reviewed entrypoint. Deployment does **not** overwrite it
  from repository code automatically. Update it deliberately after reviewing changes.
- `release.lock`: one kernel lock for automated and manual releases. A lock file at
  rest is normal. Never delete it or kill another release to bypass contention.
- `yama`: a clean, dedicated main checkout, freshly fetched per release.
- `yama-phase`, `phase_ed25519`, `github_known_hosts`: published engine objects and
  the dedicated read credential; private key mode 0600.
- `builds`: one temporary committed-source export per release, removed on exit.
- `history`: per-attempt status records and build logs. `current.json` records the
  last successful SHA, pinned Phase, image IDs and pre-release database backup.
- `previous.json`: the running image IDs and base Compose config before the last
  attempted activation, plus that attempt's database backup path. Every activation also retains its own
  `.previous.json` beside the history record, so retries preserve older rollback inputs.

`/mnt/user/appdata/yama-deploy-runner` contains the runner Compose file, image build
context, persistent `state` (UID 1001), and `ssh` (UID 1001, mode 0700). Logs are capped
at three 10 MB files. The container restarts with Docker after reboot. The image pins
the official GitHub runner by digest; the application may update inside persistent
state. Refresh the base image deliberately when upgrading/recreating the service.

The runner key must be persisted in `/boot/config/ssh/root/authorized_keys` as well
as the live authorized keys when those paths differ on Unraid. The server's existing
boot configuration restores `/usr/local/bin/python3`; Docker's restart policy restores
the runner. No new public ingress is needed.

## Release behavior

GitHub's `yama-production` concurrency group finishes an active run without cancelling
it. The host lock also protects manual releases, independent of the runner. Already healthy deployments are idempotent and do not restart. Old queued
SHAs are skipped; a release superseded during its build does not activate. A fresh
GitHub check happens before building and again before backup/activation. If GitHub or
Phase cannot be freshly checked, deployment fails closed.

Builds reuse saget's existing Docker/BuildKit cache. All three images get full-SHA tags;
`latest` changes only after verification. Activation pins the corresponding immutable image IDs, so unchanged sidecars keep
their Compose configuration and avoid needless restarts. It keeps `/mnt/user/appdata/yama/compose.override.yaml`, and runs
`docker compose up -d --no-deps --pull never yama yama-advisor yama-forge`. Secrets and data stay
server-local. The pre-release SQLite backup is mandatory. Every container must run the
expected image ID with Docker health `healthy`; `/api/health` must return plain-text
`ok`. A failed build/backup preserves the existing deployment. Failure after activation
is recorded as failure and requires inspection, never an automatic database restore.

A disconnected SSH client does not intentionally cancel the host release: SIGHUP is
ignored and builds write their own logs. Inspect the lock/process and history before
retrying. Host commands have process-group timeouts, builds are limited to 90 minutes,
the whole release has a 105-minute command deadline, and lock waits stop after 110 minutes.
A manual cancellation can revoke the ephemeral token; if fresh verification
then fails before activation, the running service is preserved.

## Setup and maintenance

1. Build `deploy/runner/Dockerfile` as `yama-deploy-runner:2.338.2` on saget. Copy
   `deploy/runner/compose.yaml` to its server directory. Create `state` and `ssh` with
   UID/GID 1001; keep the SSH private key mode 0600.
2. Install the reviewed `deploy/host.py` as the root-owned host entrypoint, mode 0700.
   Generate the two dedicated keys on the server: runner-to-host and read-only Phase.
   Add only the Phase public key to `bryanroscoe/yama-phase` deploy keys. Install verified
   GitHub host keys and the already trusted saget host key in the appropriate known-hosts
   files. Keep all existing authorized keys.
3. Register without exposing the short-lived registration token. From an authenticated
   admin terminal (run pipelines with `set -o pipefail`):

   ```sh
   gh api --method POST repos/bryanroscoe/yama/actions/runners/registration-token --jq .token |
     ssh root@<saget-lan-address> 'cd /mnt/user/appdata/yama-deploy-runner && docker compose run --rm -T runner configure'
   ssh root@<saget-lan-address> 'cd /mnt/user/appdata/yama-deploy-runner && docker compose up -d'
   gh api repos/bryanroscoe/yama/actions/runners --jq '.runners[] | {name,status,labels}'
   ```

4. Test the forced-command key: an arbitrary command must fail; `host.py check FULL_SHA`
   with a read token on stdin must authorize only passing current-main CI. Inspect
   container mounts and capabilities. No production restart is needed for these checks.
5. Merge the reviewed workflow. Its first successful main CI triggers a deployment.
   Check the Actions run, `current.json`, actual container image IDs and HTTP health.

Changes to the host entrypoint require installing the newly reviewed file on saget;
changes to the runner image/service require a controlled rebuild/recreation. A workflow
that requires a newer host protocol must coordinate that installation before merge.
Do not run historic deployment scripts from old branches: current manual releases use
`./deploy/deploy.sh`, which retains its clean-main/engine checks and then calls this
same host gate. `--check` continues to make no saget calls. Manual deployments need
`gh` authentication or a read-only `GH_TOKEN` with contents and Actions access.

## Failure and recovery

Use GitHub Actions logs plus the attempt's history record/build logs. If Docker is still
building, allow the lock owner to finish. Fix CI/build errors through a PR and merge.
For a transient deployment failure, rerun **Deploy production** on main after checking
the recorded state. Never deploy a historic SHA through this gate.

For an emergency image rollback, inspect `previous.json`, the current schema and the
migration compatibility first. It preserves the prior image IDs, base Compose content
and pre-release database backup path. Pin each prior image explicitly when applying
Compose, preserve the local override, and verify all health checks. Restoring that
backup is a separate recovery decision that can discard post-backup writes; stop the
application first and follow the existing backup/restore runbook. Do not assume that
switching an old image reverses schema changes.

## Validation

`python3 deploy/test_release.py` exercises local source/engine gates and token-free SSH
arguments. `python3 deploy/test_host.py` exercises CI/source authorization, forced SSH
command rejection, real cross-process locking, backup failure before activation,
Compose override preservation, archive failure and exact-image/plain-text health.
CI runs both alongside the full Rust and web checks. Server installation, runner
registration and a successful real deployment are separate evidence states.
