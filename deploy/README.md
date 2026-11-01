# Running Yama on saget

Yama and its advisor/Forge sidecars run on saget, Bryan's Unraid server on his LAN. It follows the same pattern as the house site (see `~/Developer/sagetserver/docs/HOUSE-DEPLOYMENT.md`):

- **Directory:** `/mnt/user/appdata/yama` on the cache SSD. It holds `compose.yaml`, a server-local `yama.env` (not in git), and `data/` (the SQLite database, engine card data and backups).
- **Reaching saget:** the scripts here read its address and SSH user from `deploy/.env` (gitignored; copy [`deploy/.env.example`](.env.example)) or the environment (`YAMA_DEPLOY_HOST`, `YAMA_DEPLOY_USER`, default `root`), and stop if it is unset. Saget's address is never written in a tracked file. In the commands below, `ssh saget` means `ssh $YAMA_DEPLOY_USER@$YAMA_DEPLOY_HOST`; a `Host saget` entry in `~/.ssh/config` makes them work as written.
- **LAN:** port 8099 on saget's LAN address (`http://$YAMA_DEPLOY_HOST:8099`). The container listens on 8787. Compose publishes the port on `YAMA_LAN_ADDRESS` from a server-local `.env` beside `compose.yaml` (`/mnt/user/appdata/yama/.env`, not in git; for example `YAMA_LAN_ADDRESS=` saget's LAN address), so only the LAN interface answers. Without it the port listens on every IPv4 interface. Until the updated `host.py` is installed on saget, its health check still expects the LAN address, so keep `YAMA_LAN_ADDRESS` unset or equal to it; the updated gate checks whatever address the running container publishes.
- **Public:** joins the existing `novalyst_default` Docker network, so the existing Cloudflare tunnel (`novalyst-cloudflared`) can route a hostname to `http://yama:8787`. No router ports are opened. Never restart `novalyst-cloudflared` or any other container for a Yama deploy.
- **Shared-table relay:** not on saget. It runs on Cloudflare (`relay.yama.ing`, Workers Free) so tables keep working while saget is down; it deploys separately, by hand: [`relay/README.md`](../relay/README.md).
- **Container hardening:** runs as `99:100`, read-only filesystem, all capabilities dropped, 5 GB memory cap. The rules engine uses about 720 MB; the lab's game threads and live games take the rest. At its cap a container doesn't fail, it slows down: every allocation waits on the kernel reclaiming pages. That is how 3 GB once turned minute-long lab games into time-outs.

## Rules (from the sagetserver repo)

Automatic releases after successful current-main CI are authorized (Bryan, 2026-10-28). Other server changes still need Bryan's request. Read-only checks (`docker ps`, `ss`, `df`) are fine. The deployment and setup scripts change the server. `./deploy/deploy.sh --check` and `sh deploy/check-release.sh` only check local/GitHub release state; `pull-db.sh` without `--fresh` only reads from saget.

Follow [Releasing Yama](RELEASING.md) before a first deploy or update: fetch GitHub, integrate the intended changes into main, check the merged result and publish main, then deploy from clean main matching freshly fetched `origin/main`. The deploy script enforces this and stops before any server call if it fails.

## First deploy

1. Run `./deploy/first-time.sh` from the verified source checkout. It creates the data
   directory, copies `yama.env.example` only when missing, and copies locally available
   pinned engine card data after checking its SHA-256. It does not regenerate that data.
2. Configure `yama.env` on saget: verified Google sign-in (`YAMA_GOOGLE_CLIENT_IDS`),
   the admin email(s), open Google sign-up (`YAMA_OPEN_SIGNUP=1`) and
   `YAMA_PASSWORD_LOGIN=0`. Use the existing approved Google OAuth client/origins;
   new accounts or provider configuration still require Bryan's request.
3. Install the reviewed [production runner and host entrypoint](RUNNER.md). Once CI
   passes on current main, the workflow deploys; a requested manual release uses
   `./deploy/deploy.sh` from clean current main and the same host gate.
4. The first authorized release creates missing advisor/Forge env files and paired
   secrets under the release lock, without printing credentials. Existing secrets,
   encryption keys, tokens, API keys and custom URLs are preserved. A missing partner
   is recovered from the existing secret; conflicting or empty paired secrets require
   explicit repair and are never silently rotated.
5. A genuinely empty installation (no Yama container and no database/WAL files) can
   start without a backup when using the default database settings and standard /data
   bind. Custom database URLs/data mounts and a rebuild containing a database must first restore a running
   Yama container using the recovery instructions so its mandatory backup can succeed.
   A missing container never makes an existing database disposable. Builds and attempt
   records live under `/mnt/user/appdata/yama-release`, as described in the runner guide.
6. The existing Cloudflare tunnel routes the approved hostname to `http://yama:8787`.
   Adding/changing a hostname is a separate setup action; a Yama release never restarts
   the tunnel or unrelated applications.

## Current sign-in setup (2026-10-18; open sign-up added 2026-10-20, off until set)

- **Google sign-in:** Google Cloud project `yama-512101`, OAuth web client `228285497505-i6ocbd3fndfdrjim4t0p2grsmiglrkfo.apps.googleusercontent.com`, authorized origins `https://yama.ing` and the legacy `https://yama.saget.org`. The client ID is public and is set in the server's `yama.env`. Yama never needs the client secret; Bryan keeps the downloaded JSON.
  - While the OAuth consent screen is in **Testing** mode, only listed test users can sign in. Either add each friend there, or publish the app (the email and profile scopes need no Google review). Open sign-up needs it published (see "Open sign-up" below).
  - Friends also need a Yama invite: `ssh saget docker exec yama yama-server invite friend@gmail.com`. Admins (`YAMA_ADMIN_EMAILS`) can invite from the Group tab instead.
- **Password accounts:** for debugging on the server, test players, or if Google sign-in breaks. `ssh saget docker exec yama yama-server user add debug@example.com --admin` prints a generated password; the login screen then shows "Sign in with a password". `user list` shows every account; `user remove-password EMAIL` turns one off. Nobody can make a password account from the app: that command is the only way. `YAMA_PASSWORD_LOGIN=0` in `yama.env` turns password sign-in off altogether. Dev login (`YAMA_DEV_LOGIN`) never works here: the container listens on 0.0.0.0, so the server ignores it.
- **Cloudflare Access:** optional, and not set up yet. If it's turned on, commander-decks' `publish.py` and `pull.py` also need an Access service token: set `YAMA_CF_ACCESS_CLIENT_ID` and `YAMA_CF_ACCESS_CLIENT_SECRET` on the Mac, and allow that token in the Access policy. The Yama script key still decides whose plan it is.
- **Public route (2026-10-28):** `yama.ing` → `http://yama:8787` on the existing `novalyst` tunnel (proxied DNS CNAME to its `cfargotunnel.com` hostname). The legacy `yama.saget.org` route remains available during migration; other tunnel routes are unchanged.

## Domain migration (2026-10-28)

`https://yama.ing` is the canonical web address and `https://yama.ing/mcp` is the connector URL.
The same server and database serve both domains; no accounts or user data are copied.

- Add the new hostname to the existing Cloudflare tunnel and a proxied CNAME to the same tunnel.
  Preserve the old hostname and all unrelated ingress rules. No connector restart is needed.
- Add `https://yama.ing` to the existing Google web client's authorized JavaScript origins,
  retaining the old origin. In Google Auth Platform, update the app homepage, privacy policy and
  terms links to the new domain and keep both authorized domains during the transition.
- Deploy the reviewed main revision with `YAMA_PUBLIC_URL=https://yama.ing` (compose.yaml).
  Verify `/api/health`, Google sign-in, public canonical URLs, `/sitemap.xml`,
  `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`.
- Sign in again at the new domain. Browser sessions, installed PWAs and offline storage belong
  to their origin: sync any pending changes on the old site before switching and install the
  PWA from the new address. Keep the old route until those clients have migrated.
- Reconnect OAuth clients at the new `/mcp` URL: issuer and resource identifiers change with
  `YAMA_PUBLIC_URL`. Existing OAuth grants for the old resource are not portable. Script keys
  still belong to the same accounts; update their configured server URL.

Rollback: restore the previous compose public URL, recreate only Yama, and use the retained
old DNS/tunnel route and Google origin. Domain routing alone never requires a database restore.

## Open sign-up (anyone with a Google account)

Off unless `yama.env` says otherwise. To turn it on:

1. **Publish the Google consent screen.** In Google Cloud console, project `yama-512101`, open Google Auth Platform (APIs & Services, OAuth consent screen), Audience, and press **Publish app**. While it says **Testing**, only the listed test users can sign in with Google at all, whatever Yama allows. Yama asks only for the email and profile scopes, which need no Google review, so publishing takes effect straight away.
2. **Tell Yama to believe the tunnel's client address.** Sign-in attempts are limited per address (10 in 10 minutes), and behind the tunnel every request arrives from the `novalyst-cloudflared` container. Cloudflare passes the visitor's address in `CF-Connecting-IP`, but Yama only believes that header from peers listed in `YAMA_TRUSTED_PROXIES`, because anyone on the LAN could send it. Find the tunnel network's range (read-only):

   ```sh
   ssh saget "docker network inspect novalyst_default -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'"
   ```

   and put it in `yama.env`, for example `YAMA_TRUSTED_PROXIES=172.18.0.0/16`. LAN requests on port 8099 normally arrive from the LAN client's own address (Docker forwards published ports without changing the source), so they are counted per device and their header is ignored. If Docker's userland proxy hands them over from the network's gateway instead, a LAN device could set the header and pick its own count; to rule that out, list only the connector's address (`docker inspect novalyst-cloudflared -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`), which changes if that container is recreated. Without this setting the limits still work, but count every tunnel visitor as one address (Yama logs a warning the first time it sees the header from a peer it doesn't trust).
3. **Set `YAMA_OPEN_SIGNUP=1`** in `yama.env` and recreate the container (`./deploy/deploy.sh`, or `docker compose up -d` in the Yama directory).

What changes:

- Anyone whose Google account has a verified email can sign in, and gets an account. There is still no username and password sign-up.
- Invites still mean something: an invited account (and every admin) keeps the full allowance. An account without an invite gets a smaller one: lab runs of 100 games, one at a time, at most `YAMA_LAB_OPEN_DAILY_GAMES` games a day (default 300); at most 2 unfinished online games; Mythic Tools CSVs up to 1 MB and plan files up to 2 MB. Inviting someone later lifts it straight away.
- Everyone but admins together may have at most `YAMA_LAB_QUEUE_GAMES` lab games waiting or playing (default 2,000), and accounts without an invite together at most `YAMA_LAB_OPEN_QUEUE_GAMES` (default 400), so new accounts can't fill the lab's queue.
- An account is tied to its Google account the first time it signs in; a different Google account with the same email is refused. Open sign-up never hands an existing password or Cloudflare Access account to a Google sign-in: invite that email first.
- Turning `YAMA_OPEN_SIGNUP` off again shuts out every account that isn't invited (their sessions and script keys stop working at once). Their data stays; inviting them lets them back in.

To keep someone out: `docker exec yama yama-server user disable EMAIL` (or Admin, People, Disable). Their sessions end at once, sign-in is refused every way, their script keys stop working and their lab runs wait. `user enable EMAIL` undoes it. An admin can only be disabled from the command line. Withdrawing an invite while sign-up is open only moves that person to the smaller allowance.

To delete an account and its data, as the privacy policy (`/privacy/`) promises on request: Admin, People, Delete, then type the account's email. Its own data goes; games and playgroups it shared with others stay without its name (ARCHITECTURE.md, "Admin area"). Admin accounts can't be deleted there: take the email out of `YAMA_ADMIN_EMAILS` first.

Rate limits (per account, admins exempt, in memory so a restart clears them): sign-in 10 tries in 10 minutes per address and per email; card search 120 a minute; name lookups 300 a minute; the offline card download 10 an hour; join codes (playgroups and online games) 20 in 10 minutes; imports 60 an hour; deck saves 120 in 10 minutes; new online games 30 an hour. Commander Spellbook checks run at most 20 an hour per account (the rest wait their turn). One account can share at most 4 life-counter tables at once.

## Ask Claude (the advisor)

"Ask Claude" answers questions about your own decks, plans, Review proposals, precons and lab runs. It runs in a second container, `yama-advisor` (`advisor/` in this repo, `deploy/Dockerfile.advisor`): Node and the Claude Agent SDK, running Claude with no tools at all (no shell, files, web, MCP, skills or settings), one throwaway home directory per question. It has no published port and sits only on the private `yama_advisor` network with `yama`, which reaches it at `http://yama-advisor:8790` with a shared secret. It logs one line per question (mode, model, outcome, time, tokens), never a question, answer, key or token.

Whose Claude answers:

- **Bryan's account** (the first admin email, written to `YAMA_ADVISOR_SUBSCRIPTION_EMAILS` by `deploy.sh`) asks on Bryan's Claude subscription. Anthropic doesn't allow an app to share one person's subscription with other people, so only listed accounts ever use it; keep that list to the subscription owner.
- **Anyone else** may save their own Anthropic API key (Group, You, Ask Claude). It is stored encrypted with `YAMA_ADVISOR_KEY_SECRET` (ChaCha20-Poly1305, bound to the account), used only for that person's questions, never shown again, and removable. Without a key the advisor says how to get one.
- **Friends Bryan chooses** may ask on the **shared key**: a separate Anthropic API key Bryan pays for per use (not his subscription). An admin turns it on per account (Admin, People, "Ask Claude on the shared key", with an optional daily cap) or on saget with `yama-server advisor share EMAIL [--daily N]`. Their own key comes first if they add one. The key lives only in the sidecar.
- Limits: 6 questions a minute and one at a time per account; 150 a day for invited accounts and 30 for accounts that joined without an invite (counted in the database, so deleting conversations doesn't reset it); none for admins. On the shared key: the grant's daily cap or else 30/150 (admins too), only `YAMA_ADVISOR_SHARED_MODELS` (default `claude-haiku-5-5`), and at most `YAMA_ADVISOR_SHARED_MONTHLY_USD` (default 10) a calendar month (UTC) for everyone together, from the cost each answer reports.

Setting it up:

1. The deployment host gate builds `yama-advisor` too, and on first authorized run writes the advisor's secrets on saget without printing them: `advisor.env` (`ADVISOR_SECRET`, mode 0600) and, in `yama.env`, `YAMA_ADVISOR_URL`, `YAMA_ADVISOR_SECRET`, `YAMA_ADVISOR_KEY_SECRET` and `YAMA_ADVISOR_SUBSCRIPTION_EMAILS`. It never overwrites them; changing `YAMA_ADVISOR_KEY_SECRET` later makes saved keys unreadable (people re-add them).
2. **Bryan connects his subscription:** `claude setup-token` on the Mac (browser sign-in; prints a token that lasts a year), then `./deploy/advisor-token.sh` and paste it. The token stays hidden, goes to saget over SSH's stdin, lands in `advisor.env` and restarts only `yama-advisor`. `./deploy/advisor-token.sh --remove` takes it off. Until then, Bryan's questions say the subscription isn't connected, and the You section says so too.

3. **The shared key (optional, only if Bryan wants friends on it):**
   1. At console.anthropic.com, create an API key (best in a workspace of its own for Yama). It's billed per use to Bryan's Anthropic account.
   2. Set a monthly spend limit there (the Console's Limits settings, for that workspace or the organization). Yama's own monthly cap (`YAMA_ADVISOR_SHARED_MONTHLY_USD`, $10 unless set in `yama.env`) stops shared questions first; the Console's limit catches anything that slips past, such as an answer stopped before it reported its cost.
   3. `./deploy/advisor-shared-key.sh` and paste the key. Like the token script: hidden paste, a check that it starts with `sk-ant-api` (a subscription token is refused), over SSH's stdin into `advisor.env` as `ANTHROPIC_SHARED_API_KEY` (mode 0600), and only `yama-advisor` restarts. `--remove` takes it off.
   4. Grant accounts: Admin, People, the account's "Ask Claude on the shared key". Or on saget: `docker exec yama yama-server advisor share matt@example.com` (`--daily 20` for a cap of its own; `advisor unshare EMAIL` to stop; `advisor shared` lists who has it and this month's spend). Admin, Server shows whether the advisor holds the key and the month's spend.

   Optional settings in `yama.env` (the defaults need nothing): `YAMA_ADVISOR_SHARED_MONTHLY_USD=10`, `YAMA_ADVISOR_SHARED_MODELS=claude-haiku-5-5` (comma-separated), `YAMA_ADVISOR_SHARED_OWNER_NAME=Bryan` (else the granting admin's display name shows: "On Bryan Roscoe's shared key").

Checks (read-only): `ssh saget 'docker logs --tail 20 yama-advisor'` (its start line says whether the subscription token and the shared key are set, never their values).

## Forge (a second engine for Lab runs)

- The deployment host gate builds `yama-forge` (deploy/Dockerfile.forge-worker, from Yama's pinned Forge build: see below) and makes `forge.env` on saget once (`FORGE_SECRET`, mode 0600, never printed), adding `YAMA_FORGE_SECRET` and `YAMA_FORGE_URL=http://yama-forge:8791` to `yama.env`.
- The worker sits on the internal `yama_forge` network with yama only: no published port, no internet. Read-only, every capability dropped, `/work` and `/tmp` as tmpfs.
- Size: `FORGE_SLOTS` games at once (3 in compose.yaml), each a JVM of `FORGE_XMX` (1536m) with 2 CPUs; the container gets 6 CPUs at a low share and 7 GB. Change all three together.
- Without the worker (or without `YAMA_FORGE_URL`/`YAMA_FORGE_SECRET`), the Lab offers phase only. With the worker down, Forge games wait and the run page says so; Admin, Server shows its state.
- Forge is GPL-3.0 and runs as a separate program; none of its code is in Yama. Private use.
- Forge build: the image unpacks Yama's own Forge build (`ARG FORGE_DIST`/`FORGE_DIST_SHA256` in the Dockerfile; label `forge <version>`, e.g. `forge 2.0.16-745401a4+yama3.54567890`: the Forge branch commit, the build's name and the tarball's hash). The tarball is Forge code: forge-referee's `dist/build-dist.sh <name> <forge checkout>` builds it (to `~/Developer/forge-engine/`), and it reaches the build as the local image `yama-forge-dist:<name>` on saget: `deploy/forge-dist.sh install` before merging a new pin (`status` to check). Without that image the release build fails for every service, not just Forge (Yama and the advisor don't deploy either), and production keeps running. Don't `docker image prune -a` it away.

## Claude's tools from outside Yama (OAuth sign-in)

Claude Code and claude.ai's custom connectors reach Yama's tools at `https://yama.ing/mcp` and sign in with OAuth, so nobody pastes a key (`server/src/oauth/`, docs/mcp-design.md slice 3).

- **Setting:** `YAMA_PUBLIC_URL`, set to `https://yama.ing` in `compose.yaml`. Every OAuth address (issuer, endpoints, the `/mcp` resource) comes from it, never from a request's Host header. Without it OAuth is off and only script keys work.
- **Where codes may go:** loopback (`http://localhost`, `127.0.0.1`, `[::1]`, any port: Claude Code) and https on `claude.ai` or `claude.com` (claude.ai's callback, `https://claude.ai/api/mcp/auth_callback`; Anthropic says it may move to claude.com). `YAMA_OAUTH_REDIRECT_HOSTS` in `yama.env` replaces that https list. Anything else is refused when the app registers, so a stranger's app can't collect someone's sign-in.
- **What must stay public:** claude.ai calls `/mcp`, `/.well-known/oauth-*`, `/oauth/register`, `/oauth/token` and `/oauth/revoke` from Anthropic's servers (`160.79.104.0/21`). If Cloudflare Access or a WAF rule is ever put in front of the hostname, leave those paths out of it. Claude Code calls them from the Mac.
- **Limits:** 30 registrations an hour and 300 token or revocation requests in 10 minutes per address (claude.ai's all come from Anthropic's addresses, so `YAMA_TRUSTED_PROXIES` matters here too), 30 sign-ins in 10 minutes per account, 20 connected apps per account, at most 500 registered apps waiting for a first sign-in. Unused registrations go after a day.
- **Ending a connection:** the person presses Disconnect in Decks, Plans, Settings. Withdrawing an invite or deleting the account ends its connections too; a disabled account's tokens are refused while it stays disabled.

## Updating

Successful push CI on current `main` automatically deploys through the dedicated saget
runner. Follow [Releasing Yama](RELEASING.md) for reviews and merge, and [runner operation](RUNNER.md)
for setup, pause, status and recovery. One server lock serializes automatic and manual
releases. The server builds committed exports, requires a SQLite backup before activation,
preserves local configuration/Compose overrides, and verifies exact image IDs plus health.
`./deploy/deploy.sh --check` still checks local source/engine readiness without contacting
saget; a requested manual retry uses `./deploy/deploy.sh` and the same server CI gate.

## Phones

Android only. The default is the installable web app, with no store; an optional Google Play app is described in [docs/mobile.md](../docs/mobile.md). It is built and published separately, not by `deploy.sh`.

- Open the Yama URL in Chrome and choose **Install app**.
- It runs full screen and works offline for the life counter and card search.
- It can use the camera for the scanner, because the public URL is HTTPS.

## Useful commands (read-only)

```sh
ssh saget 'docker logs --tail 50 yama'
./deploy/health.sh   # reads saget's LAN address from deploy/.env or the environment
```

## Debugging with real data

`./deploy/pull-db.sh` copies saget's newest backup to the local `data/yama.db` (read-only on saget; `--fresh` writes a new backup first, which changes the server). See "Signing in locally" in the main README.

## Rollback

Retag a previous image: `docker tag yama:<old-rev> yama:latest`, then `docker compose up -d` in the Yama directory. To restore data, stop the container, copy a backup over `data/yama.db`, and start it again. Taking Yama offline publicly only means removing its public hostname from the tunnel.
