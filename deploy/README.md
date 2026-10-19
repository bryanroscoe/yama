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
3. `./deploy/deploy.sh` builds the image on saget's Docker daemon (over the `unraid` docker context) and starts the container. On first start Yama downloads Scryfall card data (about 2 minutes), then refreshes prices daily.
4. In Cloudflare Zero Trust, open the `novalyst` tunnel and add a public hostname (for example `yama.saget.org`) pointing at service `http://yama:8787`.

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

## Rollback

Retag a previous image: `docker tag yama:<old-rev> yama:latest`, then `docker compose up -d` in the Yama directory. To restore data, stop the container, copy a backup over `data/yama.db`, and start it again. Taking Yama offline publicly only means removing its public hostname from the tunnel.
