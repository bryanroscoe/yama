# Yama table relay (Cloudflare)

The shared table's relay: the phones at a table meet here, so "scan to join" works when Yama's
own server (saget) or Bryan's home internet is down. One Durable Object per shared game.
Design and access rules: ARCHITECTURE.md §8. The room logic is `src/room.ts` (tested by the
repo's `npm test`); `src/index.ts` is the Worker and Durable Object around it.

- Address: `wss://relay.yama.ing/table/<gameId>/ws?role=host&secret=…` or `?role=guest&key=…`;
  `https://relay.yama.ing/health` answers `ok`.
- Plan: Workers Free (100,000 requests a day; incoming WebSocket messages count 20 to 1; each
  host snapshot is one storage write against the free 100,000 rows written a day). A game night
  is a few thousand messages.
- The web app uses it when built with `VITE_RELAY_URL=wss://relay.yama.ing`; without it, the
  server's own relay (`server/src/table_rooms.rs`).
- Logs: observability is off, so connection URLs (with host secrets) aren't stored.
- Abuse guards (2026-11-01): 30 connections a minute per client address (`CONNECTS`, Workers
  rate limiting, counted in the Worker before any Durable Object is touched), and `GUEST_JOIN`:
  set it to `off` (wrangler.toml and deploy, or the dashboard's Workers, yama-relay, Settings,
  Variables) to refuse every phone joining by code. Refused phones are told why (close codes
  4429 and 4403). If a deploy says the rate limiting binding isn't on this plan, remove the
  `[[ratelimits]]` block: the Worker runs without it. A Cloudflare WAF rate limiting rule (one
  is free: per IP, 10-second windows) on `relay.yama.ing/table/*` also stops a flood before it
  counts against the Worker's daily requests; it's set in the dashboard, not here.

## Work on it

```sh
cd relay
npm ci
npx tsc -p .              # typecheck (uses ../packages/core/src/relayKey.ts)
npx wrangler dev --port 8799
# the web app against it:
cd ../web && VITE_RELAY_URL=ws://127.0.0.1:8799 npx vite
```

## Deploy

Deployed by hand from clean `main` (it changes rarely), with the Cloudflare token from
1Password ("Bryan Code" vault, "cloudflare -admin api token"):

```sh
cd relay
npm ci
CLOUDFLARE_API_TOKEN="$(op read 'op://Bryan Code/cloudflare -admin api token/credential')" npx wrangler deploy
curl https://relay.yama.ing/health
```

Change the wire messages only together with `web/src/table/share.tsx`, `GuestTable.tsx` and
the server's relay, and keep old phones working: a phone that loaded the app before a deploy
keeps the old code until it reloads.
