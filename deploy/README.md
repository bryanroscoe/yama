# Running Yama on saget

Yama runs as one container on saget, Bryan's Unraid server at `<saget-lan-address>`. It follows the same pattern as the house site (see `~/Developer/sagetserver/docs/HOUSE-DEPLOYMENT.md`):

- **Directory:** `/mnt/user/appdata/yama` on the cache SSD. It holds `compose.yaml`, a server-local `yama.env` (not in git), and `data/` (the SQLite database, engine card data and backups).
- **LAN:** http://<saget-lan-address>:8099. The container listens on 8787.
- **Public:** joins the existing `novalyst_default` Docker network, so the existing Cloudflare tunnel (`novalyst-cloudflared`) can route a hostname to `http://yama:8787`. No router ports are opened. Never restart `novalyst-cloudflared` or any other container for a Yama deploy.
- **Container hardening:** runs as `99:100`, read-only filesystem, all capabilities dropped, 3 GB memory cap. The rules engine uses about 720 MB.

## Rules (from the sagetserver repo)

Ask Bryan before any action that changes the server. Read-only checks (`docker ps`, `ss`, `df`) are fine. Every script in this folder changes the server.

## First deploy

1. `./deploy/first-time.sh`. It creates the directory, copies `yama.env.example` to `yama.env` (only if missing), and downloads the engine card data (101 MB, checked against its SHA-256).
2. Choose how people sign in. Edit `yama.env` on the server:
   - **Cloudflare Access (recommended).** Create a self-hosted Access application for the Yama hostname, with an allow policy listing the friends' emails (one-time PIN or Google login). Put the team name and the application's audience tag into `YAMA_CF_ACCESS_TEAM` / `YAMA_CF_ACCESS_AUD`. The Access policy becomes the invite list, and Yama trusts only Cloudflare's signed token, never a bare email header.
   - **Google sign-in.** Set `YAMA_GOOGLE_CLIENT_IDS` (an OAuth web client whose authorized origin is the Yama URL) and invite people with `docker exec yama yama-server invite friend@gmail.com`.
3. `./deploy/deploy.sh` copies the source to `build/` on saget, builds the image there in the background (so a dropped SSH session can't stop it; log in `build/build.log`) and starts the container. On first start Yama downloads Scryfall card data (about 2 minutes), then refreshes prices daily.
4. In Cloudflare Zero Trust, open the `novalyst` tunnel and add a public hostname (for example `yama.saget.org`) pointing at service `http://yama:8787`.

## Current sign-in setup (2026-10-18; open sign-up added 2026-10-20, off until set)

- **Google sign-in:** Google Cloud project `yama-512101`, OAuth web client `228285497505-i6ocbd3fndfdrjim4t0p2grsmiglrkfo.apps.googleusercontent.com`, authorized origin `https://yama.saget.org`. The client ID is public and is set in the server's `yama.env`. Yama never needs the client secret; Bryan keeps the downloaded JSON.
  - While the OAuth consent screen is in **Testing** mode, only listed test users can sign in. Either add each friend there, or publish the app (the email and profile scopes need no Google review). Open sign-up needs it published (see "Open sign-up" below).
  - Friends also need a Yama invite: `ssh root@<saget-lan-address> docker exec yama yama-server invite friend@gmail.com`. Admins (`YAMA_ADMIN_EMAILS`) can invite from the Group tab instead.
- **Password accounts:** for debugging on the server, test players, or if Google sign-in breaks. `ssh root@<saget-lan-address> docker exec yama yama-server user add debug@example.com --admin` prints a generated password; the login screen then shows "Sign in with a password". `user list` shows every account; `user remove-password EMAIL` turns one off. Nobody can make a password account from the app: that command is the only way. `YAMA_PASSWORD_LOGIN=0` in `yama.env` turns password sign-in off altogether. Dev login (`YAMA_DEV_LOGIN`) never works here: the container listens on 0.0.0.0, so the server ignores it.
- **Cloudflare Access:** optional, and not set up yet. If it's turned on, commander-decks' `publish.py` and `pull.py` also need an Access service token: set `YAMA_CF_ACCESS_CLIENT_ID` and `YAMA_CF_ACCESS_CLIENT_SECRET` on the Mac, and allow that token in the Access policy. The Yama script key still decides whose plan it is.
- **Public route:** `yama.saget.org` → `http://yama:8787` on the `novalyst` tunnel, added by Bryan 2026-10-18 (DNS CNAME to the tunnel). Checked through Cloudflare: HTTPS pages, the API and WebSocket upgrades all reach Yama.

## Open sign-up (anyone with a Google account)

Off unless `yama.env` says otherwise. To turn it on:

1. **Publish the Google consent screen.** In Google Cloud console, project `yama-512101`, open Google Auth Platform (APIs & Services, OAuth consent screen), Audience, and press **Publish app**. While it says **Testing**, only the listed test users can sign in with Google at all, whatever Yama allows. Yama asks only for the email and profile scopes, which need no Google review, so publishing takes effect straight away.
2. **Tell Yama to believe the tunnel's client address.** Sign-in attempts are limited per address (10 in 10 minutes), and behind the tunnel every request arrives from the `novalyst-cloudflared` container. Cloudflare passes the visitor's address in `CF-Connecting-IP`, but Yama only believes that header from peers listed in `YAMA_TRUSTED_PROXIES`, because anyone on the LAN could send it. Find the tunnel network's range (read-only):

   ```sh
   ssh root@<saget-lan-address> "docker network inspect novalyst_default -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'"
   ```

   and put it in `yama.env`, for example `YAMA_TRUSTED_PROXIES=172.18.0.0/16`. LAN requests on port 8099 normally arrive from the LAN client's own address (Docker forwards published ports without changing the source), so they are counted per device and their header is ignored. If Docker's userland proxy hands them over from the network's gateway instead, a LAN device could set the header and pick its own count; to rule that out, list only the connector's address (`docker inspect novalyst-cloudflared -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`), which changes if that container is recreated. Without this setting the limits still work, but count every tunnel visitor as one address (Yama logs a warning the first time it sees the header from a peer it doesn't trust).
3. **Set `YAMA_OPEN_SIGNUP=1`** in `yama.env` and recreate the container (`./deploy/deploy.sh`, or `docker compose up -d` in the Yama directory).

What changes:

- Anyone whose Google account has a verified email can sign in, and gets an account. There is still no username and password sign-up.
- Invites still mean something: an invited account (and every admin) keeps the full allowance. An account without an invite gets a smaller one: lab runs of 100 games, one at a time, at most `YAMA_LAB_OPEN_DAILY_GAMES` games a day (default 300); at most 2 unfinished online games; Mythic Tools CSVs up to 1 MB and plan files up to 2 MB. Inviting someone later lifts it straight away.
- Everyone but admins together may have at most `YAMA_LAB_QUEUE_GAMES` lab games waiting or playing (default 2,000), and accounts without an invite together at most `YAMA_LAB_OPEN_QUEUE_GAMES` (default 400), so new accounts can't fill the lab's queue.
- An account is tied to its Google account the first time it signs in; a different Google account with the same email is refused. Open sign-up never hands an existing password or Cloudflare Access account to a Google sign-in: invite that email first.
- Turning `YAMA_OPEN_SIGNUP` off again shuts out every account that isn't invited (their sessions and script keys stop working at once). Their data stays; inviting them lets them back in.

To keep someone out: `docker exec yama yama-server user disable EMAIL` (or Group, You, Accounts, Disable). Their sessions end at once, sign-in is refused every way, their script keys stop working and their lab runs wait. `user enable EMAIL` undoes it. An admin can only be disabled from the command line. Withdrawing an invite while sign-up is open only moves that person to the smaller allowance.

Rate limits (per account, admins exempt, in memory so a restart clears them): sign-in 10 tries in 10 minutes per address and per email; card search 120 a minute; name lookups 300 a minute; the offline card download 10 an hour; join codes (playgroups and online games) 20 in 10 minutes; imports 60 an hour; deck saves 120 in 10 minutes; new online games 30 an hour. Commander Spellbook checks run at most 20 an hour per account (the rest wait their turn). One account can share at most 4 life-counter tables at once.

## Updating

`./deploy/deploy.sh`. It backs up the database first (`data/backups/yama-<time>.db`, written with SQLite's `VACUUM INTO`, which is safe while the server runs), rebuilds, and recreates only the `yama` container.

## Phones

Android only, no app store:

- Open the Yama URL in Chrome and choose **Install app**.
- It runs full screen and works offline for the life counter and card search.
- It can use the camera for the scanner, because the public URL is HTTPS.

## Useful commands (read-only)

```sh
ssh root@<saget-lan-address> 'docker logs --tail 50 yama'
curl -s http://<saget-lan-address>:8099/api/health
```

## Debugging with real data

`./deploy/pull-db.sh` copies saget's newest backup to the local `data/yama.db` (read-only on saget; `--fresh` writes a new backup first, which changes the server). See "Signing in locally" in the main README.

## Rollback

Retag a previous image: `docker tag yama:<old-rev> yama:latest`, then `docker compose up -d` in the Yama directory. To restore data, stop the container, copy a backup over `data/yama.db`, and start it again. Taking Yama offline publicly only means removing its public hostname from the tunnel.
