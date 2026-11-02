#!/usr/bin/env bash
# Run Yama on this machine against a copy of production's data, to see and test the real site.
#
# Usage: scripts/dev-local.sh [--refresh] [--email EMAIL] [--dry-run] [--shots [PATH...]] [-- POLISH_ARGS...]
#        npm run local -- [the same options]
#
#   (none)        copy prod's data if data/yama.db is missing, build yama-server, start it on
#                 127.0.0.1:8787 and the web app on http://localhost:5173, until Ctrl-C
#   --refresh     copy prod's newest backup again (deploy/pull-db.sh keeps the old database beside it)
#   --email EMAIL the account to sign in as (default bryanroscoe@gmail.com; also the local admin)
#   --shots [P..] once healthy, take polish screenshots of every page, or only PATH..., then stop
#   --dry-run     print the plan and change nothing
#   --            everything after goes to `npm run polish -- shoot` (with --shots)
#
# Run it from the primary checkout or any worktree. The server runs with every background job and
# outbound caller off, so nothing reaches Scryfall, Commander Spellbook, MTGJSON, Forge, Claude or
# the Mythic bridge on its own. The copy holds real people's data: never commit, upload or paste it,
# and delete data/yama*.db when you're done (see .claude/skills/yama-local/SKILL.md).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"

email=bryanroscoe@gmail.com
refresh=0
dry=0
shots=0
paths=()
polish_extra=()
api_port=8787
web_port=5173

die() { echo "dev-local: $*" >&2; exit 1; }
say() { printf 'dev-local: %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --refresh) refresh=1 ;;
    --dry-run) dry=1 ;;
    --email) [ "$#" -ge 2 ] || die '--email takes an address'; email="$2"; shift ;;
    --shots)
      shots=1
      while [ "$#" -ge 2 ] && [ "${2#-}" = "$2" ]; do paths+=("$2"); shift; done ;;
    --) shift; polish_extra=("$@"); break ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
  shift
done
case "$email" in *@*) ;; *) die "--email needs an email address" ;; esac
email="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"

tdir="${CARGO_TARGET_DIR:-target}"
bin="$tdir/debug/yama-server"
free_gb() { df -Pk "$root" | awk 'NR==2 { printf "%.1f", $4 / 1048576 }'; }
free_int() { df -Pk "$root" | awk 'NR==2 { print int($4 / 1048576) }'; }
dir_size() { if [ -d "$1" ]; then du -sk "$1" 2>/dev/null | awk '{ printf "%.1f GiB", $1 / 1048576 }'; else echo 'not built yet'; fi; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN > /dev/null 2>&1; }

# Every outbound or background job off, and the server only reachable from this machine. They are
# set in the environment (set but empty counts as set), so a .env file can't switch one back on.
server_env=(
  "YAMA_BIND=127.0.0.1:$api_port"
  YAMA_DATA_DIR=data
  DATABASE_URL=sqlite://data/yama.db
  YAMA_DEV_LOGIN=1
  "YAMA_ADMIN_EMAILS=$email"
  YAMA_AUTO_IMPORT=0       # no Scryfall, calendar, MTGJSON, deck-price or scanner-bundle downloads
  YAMA_DECK_CHECKS=0       # no deck lists sent to Commander Spellbook
  YAMA_LAB_THREADS=0       # no simulation games
  YAMA_MYTHIC_BRIDGE=0
  YAMA_PUBLIC_URL=         # no OAuth for Claude's connectors, no absolute public links
  YAMA_FORGE_URL=
  YAMA_FORGE_SECRET=
  YAMA_ADVISOR_URL=
  YAMA_ADVISOR_SECRET=
  YAMA_ADVISOR_KEY_SECRET=
  YAMA_ADVISOR_TOOLS_URL=
  YAMA_ADVISOR_SUBSCRIPTION_EMAILS=
  YAMA_CF_ACCESS_TEAM=
  YAMA_CF_ACCESS_AUD=
  YAMA_GOOGLE_CLIENT_IDS=
  YAMA_OPEN_SIGNUP=0
  YAMA_SECURE_COOKIES=0
  YAMA_TRUSTED_PROXIES=
  YAMA_CORS_ORIGINS=
  YAMA_OAUTH_REDIRECT_HOSTS=
)
show_env() { for kv in "${server_env[@]}"; do printf '    %s\n' "$kv"; done; }

need_db=0
if [ ! -f data/yama.db ] || [ "$refresh" = 1 ]; then need_db=1; fi

free="$(free_gb)"
say "checkout: $root"
say "free disk: $free GiB on this volume; Rust output in $tdir: $(dir_size "$tdir")"
if [ "$need_db" = 1 ]; then say "database: will copy prod's newest backup to data/yama.db (deploy/pull-db.sh, read-only on saget)"; else say "database: using data/yama.db ($(du -sk data/yama.db | awk '{ printf "%.0f MiB", $1 / 1024 }')); --refresh copies prod again"; fi
say "server: $bin serve on 127.0.0.1:$api_port with:"
show_env
say "web: npm run dev on http://localhost:$web_port"
if [ "$shots" = 1 ]; then
  say "then: npm run polish -- shoot --base http://localhost:$web_port --as $email ${polish_extra[*]:-} ${paths[*]:-}"
fi

if [ "$dry" = 1 ]; then
  say 'dry run: nothing was copied, built or started.'
  [ -d node_modules ] || say 'a real run would first run npm ci (no node_modules here).'
  [ -d ../yama-phase ] || say "a real run needs the engine checkout at $root/../yama-phase (deploy/phase-rev) for Cargo; it is missing."
  if [ "$need_db" = 1 ] && [ -z "${YAMA_DEPLOY_HOST:-}" ] && [ ! -f deploy/.env ]; then
    say 'a real run could not copy prod: set YAMA_DEPLOY_HOST (or copy deploy/.env.example to deploy/.env).'
  fi
  for port in "$api_port" "$web_port"; do
    ! listening "$port" || say "port $port is in use; a real run would stop here."
  done
  exit 0
fi

# Preflight: fail before copying or building anything.
for port in "$api_port" "$web_port"; do
  if listening "$port"; then die "port $port is already in use; stop whatever is using it (lsof -nP -iTCP:$port -sTCP:LISTEN)."; fi
done
command -v cargo > /dev/null || die 'cargo is not installed.'
command -v node > /dev/null || die 'node is not installed.'
[ -d ../yama-phase ] || die "Cargo needs the engine checkout at $root/../yama-phase, pinned at deploy/phase-rev (README, Run it locally)."
if [ "$need_db" = 1 ] && [ -z "${YAMA_DEPLOY_HOST:-}" ] && [ ! -f deploy/.env ]; then
  die 'to copy prod I need saget'"'"'s address: export YAMA_DEPLOY_HOST (and YAMA_DEPLOY_USER), or copy deploy/.env.example to deploy/.env.'
fi
# Rule of thumb from the machine's hygiene rules: keep 20 GiB free after a build; a first build in a
# checkout adds roughly 5 GiB.
floor=20
[ -d "$tdir" ] || floor=25
if [ "$(free_int)" -lt "$floor" ]; then
  die "only $free GiB free (need $floor GiB before building). Free space first, e.g. agent-clean on a retired worktree; don't build into a nearly full disk."
fi

if [ ! -d node_modules ]; then
  say 'npm ci (no node_modules in this checkout)'
  npm ci --no-audit --no-fund
fi

if [ "$need_db" = 1 ]; then
  say "copying prod's data (real people's data: keep it out of git, PRs and uploads)"
  deploy/pull-db.sh
  kept=(data/yama.local-*.db)
  if [ -e "${kept[0]}" ]; then
    say "the previous database is kept as ${kept[*]}; delete what you don't need (rm data/yama.local-*.db)."
  fi
fi

say 'building yama-server with CARGO_BUILD_JOBS=1 (agent-build-guard applies; "waiting for the shared compiler slot" is normal)'
if ! CARGO_BUILD_JOBS=1 cargo build -p yama-server; then
  die 'the build failed or the build guard stopped it. A memory cutoff is a failed check: do not retry it unchanged or work around the guard.'
fi
[ -x "$bin" ] || die "built, but there is no $bin; with a custom target directory set CARGO_TARGET_DIR to it."
say "Rust output in $tdir is now $(dir_size "$tdir"); free disk $(free_gb) GiB"

logs="$(mktemp -d "${TMPDIR:-/tmp}/yama-local.XXXXXX")"
server_pid=''
web_pid=''
# shellcheck disable=SC2329  # runs from the EXIT trap
stop() {
  trap '' INT TERM
  for pid in "$web_pid" "$server_pid"; do
    if [ -n "$pid" ]; then kill -TERM -- "-$pid" 2> /dev/null || true; fi
  done
  for pid in "$web_pid" "$server_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2> /dev/null || true; fi
  done
  rm -rf "$logs"
}
trap stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Job control gives each background job its own process group, so stopping takes npm's children too.
set -m
env "${server_env[@]}" "$bin" serve > "$logs/server.log" 2>&1 &
server_pid=$!

wait_for() { # URL PID LOG NAME
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "$1" 2> /dev/null; then return 0; fi
    if ! kill -0 "$2" 2> /dev/null; then
      echo "dev-local: $4 stopped while starting. Its log:" >&2
      tail -n 30 "$3" >&2
      return 1
    fi
    sleep 1
  done
  echo "dev-local: $4 didn't answer at $1 within two minutes. Its log:" >&2
  tail -n 30 "$3" >&2
  return 1
}
wait_for "http://127.0.0.1:$api_port/api/health" "$server_pid" "$logs/server.log" 'the server' || exit 1

npm run dev -w web -- --strictPort > "$logs/web.log" 2>&1 &
web_pid=$!
wait_for "http://localhost:$web_port/" "$web_pid" "$logs/web.log" 'the web app' || exit 1

cat <<EOF

Yama is running on a copy of production's data:
  web      http://localhost:$web_port
  server   http://127.0.0.1:$api_port (API only)
Sign in: open the web address and use "Sign in (development)" with $email (no password).
That account exists in the copy, so you see its real decks, collection and games; $email is the
local admin. Nothing here is written back to production.
Background jobs and outbound callers are off: no card or price imports, no Spellbook, no Lab games.
EOF

if [ "$shots" = 1 ]; then
  say 'taking screenshots (read-only: every request that is not a GET is blocked)'
  status=0
  npm run polish -- shoot --base "http://localhost:$web_port" --as "$email" ${polish_extra[@]+"${polish_extra[@]}"} ${paths[@]+"${paths[@]}"} || status=$?
  say 'Screenshots are under output/polish/ (git-ignored); delete a run once you have what you need.'
  exit "$status"
fi

echo 'Press Ctrl-C to stop both.'
while kill -0 "$server_pid" 2> /dev/null && kill -0 "$web_pid" 2> /dev/null; do sleep 2; done
echo 'dev-local: one of the processes stopped. Logs:' >&2
tail -n 20 "$logs/server.log" "$logs/web.log" >&2 || true
exit 1
