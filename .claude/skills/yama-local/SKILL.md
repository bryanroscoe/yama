---
name: yama-local
description: Run Yama locally on a copy of production's data to see the site, sign in, run npm test, typecheck and local-ci, and take polish screenshots of local or production pages. Use when asked to run, start, screenshot or try the Yama app, show how the site works, or check a UI change in the real app.
---

# Run Yama locally

Bryan (2 Nov 2026): taking a copy of prod is fine, because it is only him and a friend's data. We need to run and test locally, screenshot pages and run workflows without touching production.

## Where to run it

From any worktree (T3-managed, or `~/Developer/.worktrees/yama/<task>`). The primary checkout `~/Developer/yama` stays on origin/main and clean: don't edit, commit or switch branches there. After a PR merges, `scripts/sync-main.sh` brings it current. Check `df -h /System/Volumes/Data` first: a first build in a checkout adds about 5 GiB of `target/`, and the script refuses below 25 GiB free (20 GiB with an existing `target/`). On this Mac Cargo runs through the build guard with `CARGO_BUILD_JOBS=1`; "waiting for the shared compiler slot" is normal, and a memory cutoff is a failed check (don't retry unchanged or bypass the guard). Retire the worktree when the task is done (`agent-clean`, then `git worktree remove`).

## Run it

```sh
npm run local                       # copy prod's data if data/yama.db is missing, build, serve, Vite
npm run local -- --refresh          # copy prod's newest backup again
npm run local -- --dry-run          # print the plan, change nothing
npm run local -- --shots            # once up: polish screenshots of every page, then stop
npm run local -- --shots /decks /cards -- --viewports mobile
```

`scripts/dev-local.sh` copies the data with `deploy/pull-db.sh` (read-only on saget; needs `YAMA_DEPLOY_HOST`, or `deploy/.env`), builds `yama-server`, starts it on `127.0.0.1:8787` and Vite on `http://localhost:5173`, and stops both on Ctrl-C or exit. The server runs with background and outbound work off: no Scryfall, calendar, MTGJSON, deck-price or scanner-bundle downloads (`YAMA_AUTO_IMPORT=0`), no Commander Spellbook (`YAMA_DECK_CHECKS=0`), no Lab games (`YAMA_LAB_THREADS=0`), no Forge, Ask Claude advisor, Mythic bridge, OAuth or public URL. Card art still loads from Scryfall in the browser. Online play needs the engine card data in `data/engine/` (docs/engine-integration.md); without it online play and Lab games are off.

Two read-only pages still fetch public data on request, because no setting turns them off: `/api/scan/bundle` (the card scanner's recognition files) and `/api/calendar/precons/<file>` (a precon list from MTGJSON, when not cached). Neither sends account data.

## Sign in

Open `http://localhost:5173`, press "Sign in (development)" and enter `bryanroscoe@gmail.com` (or another account in the copy; `--email` changes the local admin). No password. A typo makes a new, empty account. The polish tool signs in the same way (`--as EMAIL`).

## Checks

```sh
npm ci                                  # in the worktree, once
npm test && npm run typecheck           # web and core
CARGO_BUILD_JOBS=1 scripts/local-ci.sh --no-amend   # every CI check; needs a clean tree, ../yama-phase at deploy/phase-rev
```

CI tests are off on GitHub (AGENTS.md): on the final head, after reconciling with main, you are the CI. Report exactly what ran on which commit as local evidence. Don't run cargo while another agent holds the build budget unless your task is the Rust one.

## Screenshots

`npm run polish` (docs/polish.md) drives Chrome at laptop, tablet and mobile sizes and writes `output/polish/<time>/report.md`, `index.html` and shots (git-ignored). It is read-only: non-GET requests are blocked and sockets never open.

```sh
npm run polish -- shoot --base http://localhost:5173 --as bryanroscoe@gmail.com            # local (server and Vite already up)
npm run polish -- shoot --base https://yama.saget.org --as bryanroscoe@gmail.com /decks   # production, over SSH session
```

Production runs are read-only too, but never probe a new static path on https://yama.ing before its deploy (Cloudflare caches the SPA fallback for 4 hours). Delete a run's folder once its findings are dealt with.

## Privacy

The copy holds real people's data: decks, collections, games, accounts and emails.

- Never commit it, upload it, send it to an outside service or paste it, or screenshots of private pages, into PRs, issues or chat. A screenshot in a PR must come from an account or deck the person agreed to show, or from public pages.
- `data/yama*.db`, `output/` and `.env` are git-ignored; keep it that way. Don't move the files elsewhere.
- Delete scratch copies after use: `rm data/yama.db* data/yama.local-*.db*` in your worktree, and old `output/polish/` runs. `--refresh` keeps the previous database as `data/yama.local-<time>.db`; remove it too.
- Nothing local writes back to production. Don't point the local server at a production `DATABASE_URL`, and don't turn the outbound knobs on for a prod copy.
