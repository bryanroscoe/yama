#!/bin/sh
# Copy saget's newest database backup into the local data/ folder, to debug against real data.
#
#   ./deploy/pull-db.sh           read-only on saget: copies the newest existing backup
#   ./deploy/pull-db.sh --fresh   first writes a new backup on saget (this changes the server:
#                                 only run it when Bryan has said so)
#
# The local database is kept as data/yama.local-<time>.db, never deleted. Stop the local server
# first. Afterwards, sign in locally as yourself with dev login (YAMA_DEV_LOGIN=1) or give your
# account a password: `./target/debug/yama-server user add you@example.com --admin`.
set -eu
cd "$(dirname "$0")/.."
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama

if lsof -nP -iTCP:8787 -sTCP:LISTEN > /dev/null 2>&1; then
  echo "The local server is running on port 8787. Stop it first, then run this again."; exit 1
fi

if [ "${1:-}" = "--fresh" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  echo "Writing a new backup on saget…"
  ssh "$HOST" "docker exec yama yama-server backup /data/backups/yama-$STAMP.db"
fi

# Never open a backup in place on the server; only list and copy.
LATEST=$(ssh "$HOST" "ls -t $DIR/data/backups/yama-*.db 2>/dev/null | head -1")
if [ -z "$LATEST" ]; then
  echo "No backups on saget yet. Run with --fresh (changes the server) or deploy once."; exit 1
fi
echo "Copying $LATEST…"
mkdir -p data
scp -q "$HOST:$LATEST" data/yama.pulled.db

if [ -f data/yama.db ]; then
  KEEP="data/yama.local-$(date +%Y%m%d-%H%M%S).db"
  mv data/yama.db "$KEEP"
  # The WAL holds the old database's latest writes; it moves with it (SQLite finds "<db>-wal").
  [ -f data/yama.db-wal ] && mv data/yama.db-wal "$KEEP-wal"
  rm -f data/yama.db-shm
  echo "Kept the old local database as $KEEP"
fi
mv data/yama.pulled.db data/yama.db
echo "Done. data/yama.db is now saget's $(basename "$LATEST")."
