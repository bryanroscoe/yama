#!/bin/sh
# Build Yama on saget's Docker daemon (over SSH) and restart the container.
# Every run changes the server: only run it when Bryan has said to deploy.
set -eu
cd "$(dirname "$0")/.."
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama
REV=$(git rev-parse --short HEAD)

echo "Building yama:$REV on saget…"
docker --context unraid build -f deploy/Dockerfile --build-context phase=../yama-phase \
  -t yama:latest -t "yama:$REV" .

echo "Backing up the database, then restarting…"
scp -q deploy/compose.yaml "$HOST:$DIR/compose.yaml"
STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "cd $DIR && mkdir -p data/backups && \
  (docker exec yama yama-server backup /data/backups/yama-$STAMP.db || echo 'no running yama to back up') && \
  docker compose up -d && sleep 5 && docker ps --filter name=^yama\$ --format '{{.Names}}: {{.Status}}'"
echo "Done: yama:$REV. LAN http://<saget-lan-address>:8099"
