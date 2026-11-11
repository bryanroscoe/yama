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
  a commit on main, latest push CI for that SHA, the CI workflow identity, success,
  branch, event and source repository. If main moved on after the request, the commit still
  deploys while it stays on main, even when newer commits have passed CI; their own requests
  deploy after it. A commit off main, or older than production, never deploys (Bryan,
  2026-11-02: requiring the exact tip starved every release while merges landed every few
  minutes, and so did yielding to a newer commit once push CI passed in about a minute).
  A PR job cannot grant itself deployment access merely by selecting the runner label.
  Ordinary CI uses a separate `yama-ci` runner,
  state/cache and container with no deployment key; see [CI setup](../docs/ci.md).
- Yama Git/API access uses the request's ephemeral token, only in memory/per-process
  git configuration. Phase is fetched over HTTPS from the public fork without a deploy key. Tokens
  never enter Docker contexts, application environments, logs, or command arguments.

## Server layout

`/mnt/user/appdata/yama-release` (root-owned, mode 0700) contains:

- `host.py`: the installed, reviewed entrypoint. Deployment does **not** overwrite it
  from repository code automatically. Update it deliberately after reviewing changes.
  The historical-runtime upgrade in PR #29 requires the exporter that supplies the
  `historical-source` Docker context and the engine-data preflight below. **Do not
  merge that upgrade until this reviewed host version is installed and verified.**
  The updated host still supports main revisions preceding the historical worker,
  so the host can be installed before the application change. Repository tests do
  not prove that the separately installed copy has been updated.
- `release.lock`: one kernel lock for automated and manual releases. A lock file at
  rest is normal. Never delete it or kill another release to bypass contention.
- `yama`: a clean, dedicated main checkout, freshly fetched per release.
- `yama-phase`: published public engine objects. No Phase deploy credential is needed.
- `builds`: one temporary committed-source export per release, removed on exit.
- `history`: per-attempt status records and build logs. Authorized attempts are recorded
  before Yama/Phase preparation, with their stage and sanitized failure reason. `current.json` records the
  last successful SHA, pinned Phase, image IDs and pre-release database backup.
- `previous.json`: the running image IDs and base Compose config before the last
  attempted activation, plus that attempt's database backup path. Every activation also retains its own
  `.previous.json` beside the history record, so retries preserve older rollback inputs.
- `/mnt/user/appdata/yama/data/backups`: one SQLite copy per activation. After a healthy
  activation the host deletes its `*.db` files older than 48 hours, keeping the newest three
  and the copies that `previous.json` and `current.json` name. Nothing is deleted after a
  failed, refused or superseded attempt. Retention runs only from the installed host, so
  installing a changed `host.py` here is what turns it on (see Updating in `deploy/README.md`).

Before activation, the updated host resolves the candidate Compose configuration
(including the server override and environment), then verifies the current and
historical engine data bytes against `deploy/engine-data.json` and
`runtime/historical.json`. Missing files, stale explicit overrides, wrong hashes,
symlink paths, and unsupported mounts refuse activation before backup, Compose
replacement, or restart. Stage both immutable artifacts before release; this gate
does not download files or rewrite server configuration. An isolated candidate-image
probe then runs as the configured runtime user with no network, credentials or
database, and mounts only the two data files read-only. It checks the current file
hash, verifies the packaged historical executable against its image-owned digest,
and loads the historical data through that executable. Before this file-only probe,
the host checks traversal permissions on every container-visible bind-mounted parent
directory, using the configured numeric UID, primary GID and supplementary groups.
Private parent directories therefore cannot be hidden by the probe's isolated mounts.
This check requires Linux extended attributes and an unremapped Docker identity;
directory ACLs, named IDs and unsupported user namespaces refuse activation instead
of inferring access from incomplete metadata. The probe also uses the configured
supplementary groups. A failed or timed-out probe
refuses activation and removes its own container. This does not make plain
`/api/health` an engine-readiness check. Install and verify the reviewed host exporter separately before merge;
neither its production installation nor the data copy has been performed by PR #29.

`first-time.sh` reuses an artifact only after its remote digest passes. An SSH
transport failure aborts setup. Missing or incorrect artifacts are uploaded to a
temporary sibling, verified and assigned the runtime owner there, then atomically
renamed into place. Failed transfers or checks preserve the previous destination;
setup attempts to remove its temporary file on exit. An interrupted SSH connection
can leave that temporary sibling for explicit inspection, never a partial pinned file.

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
it. The host lock also protects manual releases, independent of the runner. Already healthy deployments are idempotent and do not restart. GitHub keeps
only the newest pending request. A request that gets the lock builds and activates its commit
while that commit is still on main and its own push CI still passes; production never goes
back. Merges during the wait or build no longer discard it (2026-11-02: production sat on one
commit while main moved through four, each merge superseding the ~20-minute build in progress).
A request doesn't yield to a newer passed commit before building either: any CI completion on
main (a manual run, say) queues a deploy run that can replace that commit's pending request and
then skip its jobs, so yielding could leave nothing deploying. At most one extra build runs. Fresh
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
A superseded run still succeeds (skipping an old request is normal) but carries a
"Not deployed" warning annotation, and the host log above it says why.
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
  connects with `ProxyCommand cloudflared access ssh --hostname %h`, passing the Access service
  token through cloudflared's `TUNNEL_SERVICE_TOKEN_ID`/`TUNNEL_SERVICE_TOKEN_SECRET` environment. It needs these secrets, set on the `production` environment:

  | Secret | Value |
  |---|---|
  | `DEPLOY_SSH_HOST` | The Cloudflare Access SSH hostname for saget (not its LAN address) |
  | `DEPLOY_SSH_KEY` | A dedicated ed25519 private key, forced to the release gate on saget |
  | `DEPLOY_KNOWN_HOSTS` | `<Access hostname> <saget's SSH host key>`, one line per key type |
  | `CF_ACCESS_CLIENT_ID` | The Access service token's client ID |
  | `CF_ACCESS_CLIENT_SECRET` | The Access service token's client secret |

  Environment secrets take precedence over repository secrets of the same name, so the
  repository-level `DEPLOY_SSH_HOST` keeps serving the runner backend until the switch. Since the
  repository went public it uses this backend only: keep the secrets in the `production`
  environment (deployment branches: `main`), and never register the saget runner on it.

The pin is `cloudflared` 2026.5.1: later releases are reported to ignore service tokens for
`access ssh` and fall back to browser login
([cloudflare/cloudflared#1674](https://github.com/cloudflare/cloudflared/issues/1674)). To
update it, first confirm that a newer release authenticates headlessly with the service token,
then change `CLOUDFLARED_VERSION` and `CLOUDFLARED_SHA256` together in `deploy.yml`, taking the
digest from the release asset `cloudflared-linux-amd64` and checking it against a fresh download.

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
   Generate the dedicated runner-to-host key on the server. The public Phase checkout
   needs no deploy key. Install the already trusted saget host key in the runner's known-hosts
   file. Keep all existing authorized keys.
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

A merged revert no longer stops a release that is already building (2026-11-02): the reverted
commit is still on main, so it activates and the revert deploys after it. To stop it, cancel
its **Deploy production** run in GitHub Actions. That ends the job's token, so the host's next
GitHub check fails and the running service is preserved, as long as that check is still ahead:
the last one runs after the backup, just before the config switch. Read the history record to
see which stage it reached.

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
