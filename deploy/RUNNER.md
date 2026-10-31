# Production deployment runner

Bryan authorized this setup on 2026-10-28. Successful **push CI on current main** now
requests an automatic production release. Feature PRs still need review and passing
checks before merge. Merging main is consequently a production release decision.
Pause deployments by stopping `yama-deploy-runner` on saget (runner backend) or with
`gh workflow disable deploy.yml -R bryanroscoe/yama` (either backend); CI and PRs keep working.
The workflow reaches saget through one of two backends; see [Choose the deploy backend](#choose-the-deploy-backend).

## Ownership and access

- `.github/workflows/deploy.yml` runs after successful `CI` for a main push, or manually
  on main. It uses read-only Actions/contents permissions and a short-lived token.
- With the default `runner` backend, the dedicated `saget-yama-production` runner is a Linux container on saget. Its only
  mounts are its own state and a read-only SSH directory. No Docker socket, production
  data, application env files, or server Git credentials are mounted in the runner.
- Its SSH key has `restrict,command="/usr/local/bin/python3 /mnt/user/appdata/yama-release/host.py"`
  in root's authorized keys. The host validates the complete original command; only
  `host.py deploy|check FULL_SHA` is accepted. No shell, SCP, forwarding, or PTY is allowed.
- The host entrypoint lives outside runner-writable paths. It checks GitHub itself:
  exact current main, latest push CI for that SHA, the CI workflow identity, success,
  branch, event and source repository. A PR job cannot grant itself deployment access
  merely by selecting the runner label. Ordinary CI uses a separate `yama-ci` runner,
  state/cache and container with no deployment key; see [CI setup](../docs/ci.md).
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
- `history`: per-attempt status records and build logs. Authorized attempts are recorded
  before Yama/Phase preparation, with their stage and sanitized failure reason. `current.json` records the
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
SHAs are skipped; a release superseded during its build does not activate. Fresh
GitHub checks happen before building, after building, and after backup immediately
before switching the live Compose configuration. If GitHub or
Phase cannot be freshly checked, deployment fails closed.

After verifying successful CI, a release reserves the fleet's existing
`/mnt/user/appdata/github-ci/slots/admission.lock` before waiting for exclusive
`release.lock`. Admitted CI jobs finish normally; new jobs release partial reservations
and wait. This prevents CI from starving a pending release without cancelling jobs or
pausing containers. Both waits share the existing 110-minute deadline. If the fleet
directory exists but its admission lock is missing, the request fails closed; a host
without the fleet keeps the standalone release lock behavior. Check-only and unready
requests never reserve priority. Never replace either lock file.

The host prints a `YAMA_RELEASE_RESULT` outcome after finishing. GitHub's summary says
whether the SHA was deployed, was already healthy, or was superseded without activation.
Install the reviewed host entrypoint before using the updated workflow; a missing result
is an error, not evidence of activation.

Builds reuse saget's existing Docker/BuildKit cache. All three images get full-SHA tags;
`latest` changes only after verification. Activation pins the corresponding immutable image IDs, so unchanged sidecars keep
their Compose configuration and avoid needless restarts. It keeps `/mnt/user/appdata/yama/compose.override.yaml`, and runs
`docker compose up -d --no-deps --pull never yama yama-advisor yama-forge`. Secrets and data stay
server-local. Missing sidecar env files/pairs are initialized once under the host lock;
existing credentials and custom settings are never rotated. Conflicting/empty pairs
require explicit repair. The pre-release SQLite backup is mandatory for any existing
database. Only an empty first installation with no Yama container or database/WAL
files can initialize without one, and only with the default database path and standard
/data bind. Custom database settings/mounts and rebuilds with data require a running backup source. Every container must run the
expected image ID with Docker health `healthy`; `/api/health` must return plain-text
`ok`. A failed build/backup preserves the existing deployment. Failure after activation
is recorded as failure and requires inspection, never an automatic database restore.

A disconnected SSH client does not intentionally cancel the host release: SIGHUP is
ignored and builds write their own logs. Inspect the lock/process and history before
retrying. Host commands have process-group timeouts, builds are limited to 90 minutes,
the whole release has a 105-minute command deadline, and lock waits stop after 110 minutes.
The Actions job allows 240 minutes, covering both bounds plus startup and cleanup.
A manual cancellation can revoke the ephemeral token; if fresh verification
then fails before activation, the running service is preserved.

## Choose the deploy backend

The repository Actions variable `DEPLOY_BACKEND` selects how `deploy.yml` reaches saget,
like `CI_LINUX_RUNNER` does for CI. Both backends send only the release request and the
short-lived token to the same forced `host.py deploy FULL_SHA` gate, keep strict host-key
checking and report the same `YAMA_RELEASE_RESULT`. No backend checks out code.

- **Unset or `runner` (default):** the self-hosted `yama-production` runner on saget's LAN,
  with its key and known hosts under `/run/yama-deploy`. The host comes from the repository
  secret `DEPLOY_SSH_HOST` (saget's LAN address); an unknown backend value fails the job.
- **`cloudflare`:** a one-use GitHub-hosted `ubuntu-24.04` job in the GitHub environment
  `production`. It installs a pinned `cloudflared` release, checks its SHA-256, writes the
  deploy key and known hosts to a mode-600 temporary directory that is removed on exit, and
  connects with `ProxyCommand cloudflared access ssh --hostname %h` and an Access service
  token. It needs these secrets, set on the `production` environment:

  | Secret | Value |
  |---|---|
  | `DEPLOY_SSH_HOST` | The Cloudflare Access SSH hostname for saget (not its LAN address) |
  | `DEPLOY_SSH_KEY` | A dedicated ed25519 private key, forced to the release gate on saget |
  | `DEPLOY_KNOWN_HOSTS` | `<Access hostname> <saget's SSH host key>`, one line per key type |
  | `CF_ACCESS_CLIENT_ID` | The Access service token's client ID |
  | `CF_ACCESS_CLIENT_SECRET` | The Access service token's client secret |

  Environment secrets take precedence over repository secrets of the same name, so the
  repository-level `DEPLOY_SSH_HOST` keeps serving the runner backend until the switch. If
  the account's plan offers no environment secrets for this private repository, set them as
  repository secrets at the moment of switching instead (replacing the runner's host).

To update the pinned `cloudflared`, change `CLOUDFLARED_VERSION` and `CLOUDFLARED_SHA256`
together in `deploy.yml`, taking the digest from the release asset `cloudflared-linux-amd64`
and checking it against a fresh download.

### Set up the Cloudflare backend

These steps change Cloudflare and saget; do them only when Bryan asks. Nothing here needs
a router port or a restart of `novalyst-cloudflared`.

1. **Route SSH through the tunnel.** In Cloudflare Zero Trust, add a public hostname to the
   existing remotely managed tunnel: service `ssh://<saget's LAN address>:22`. Configuration
   changes reach the running connector without a restart.
2. **Protect it with Access.** Create a self-hosted Access application for that hostname and
   a service token for GitHub deploys. Give the application one policy with action
   **Service Auth** that includes only that token. Record the token's expiry and rotate it
   before then.
3. **Make a dedicated deploy key** (do not reuse the runner's). Add its public key to root's
   authorized keys on saget, in both the live file and `/boot/config/ssh/root/authorized_keys`,
   with the same `restrict,command="/usr/local/bin/python3 /mnt/user/appdata/yama-release/host.py"`
   prefix as the runner's key.
4. **Pin saget's host key** under the Access hostname, because SSH checks the name it was
   given: take `/etc/ssh/ssh_host_ed25519_key.pub` from saget, confirm its fingerprint matches
   the entry already trusted on the LAN, and write `<Access hostname> ssh-ed25519 AAAA…`.
5. **Store the secrets** in the `production` environment (Settings, Environments) and limit
   that environment's deployment branches to `main`.
6. **Switch and verify:** `gh variable set DEPLOY_BACKEND --body cloudflare -R bryanroscoe/yama`,
   then `gh workflow run deploy.yml --ref main -R bryanroscoe/yama`. An unchanged main reports
   "Already deployed and health-verified" without restarting anything. Check the run summary.
7. **Retire the runner** once a Cloudflare release has succeeded: stop `yama-deploy-runner`,
   remove its registration (`gh api --method DELETE repos/bryanroscoe/yama/actions/runners/ID`),
   remove its key from both authorized-keys files, and delete the repository-level
   `DEPLOY_SSH_HOST` if nothing else uses it. To switch back before then, set `DEPLOY_BACKEND`
   to `runner`.

**Before the repository could ever be public**, retire every persistent self-hosted runner
registered to it (`yama-production` and the saget `yama-ci` worker): on a public repository
any fork pull request could target their labels. The Cloudflare backend and GitHub-hosted CI
need no self-hosted runner. Saget's address, SSH user and the Access hostname stay in
`deploy/.env` and Actions secrets, never in tracked files.

## Setup and maintenance

First prepare the app directory and `yama.env` with [the first-deploy procedure](README.md#first-deploy).
Missing advisor/Forge configuration is created by the first authorized release.

These steps set up the default `runner` backend.

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
     ssh saget 'cd /mnt/user/appdata/yama-deploy-runner && docker compose run --rm -T runner configure'
   ssh saget 'cd /mnt/user/appdata/yama-deploy-runner && docker compose up -d'
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
