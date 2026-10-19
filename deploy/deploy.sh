#!/bin/sh
# Build Yama on saget's Docker daemon (over SSH) and restart the container.
# Every run changes the server: only run it when Bryan has said to deploy.
set -eu
cd "$(dirname "$0")/.."
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama
REV=$(git rev-parse --short HEAD)

echo "Copying source to saget…"
# The build runs on saget itself (detached), so a dropped SSH connection can't kill it.
rsync -a --delete --exclude target --exclude node_modules --exclude data --exclude .git \
  --exclude web/dist --exclude web/public/ocr --exclude .env ./ "$HOST:$DIR/build/yama/"
rsync -a --delete --include Cargo.toml --include 'crates/***' --exclude '*' ../yama-phase/ "$HOST:$DIR/build/yama-phase/"

echo "Building yama:$REV on saget (log: $DIR/build/build.log)…"
ssh "$HOST" "cd $DIR/build && rm -f build.status && \
  nohup sh -c 'docker build -f yama/deploy/Dockerfile --build-context phase=yama-phase -t yama:latest -t yama:$REV yama \
    > build.log 2>&1; echo \$? > build.status' > /dev/null 2>&1 &"
while ! ssh "$HOST" "test -f $DIR/build/build.status"; do sleep 20; done
if [ "$(ssh "$HOST" "cat $DIR/build/build.status")" != "0" ]; then
  ssh "$HOST" "tail -30 $DIR/build/build.log"; echo "Build failed."; exit 1
fi

echo "Backing up the database, then restarting…"
scp -q deploy/compose.yaml "$HOST:$DIR/compose.yaml"
STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "cd $DIR && mkdir -p data/backups && \
  (docker exec yama yama-server backup /data/backups/yama-$STAMP.db || echo 'no running yama to back up') && \
  docker compose up -d && sleep 5 && docker ps --filter name=^yama\$ --format '{{.Names}}: {{.Status}}'"
echo "Done: yama:$REV. LAN http://<saget-lan-address>:8099"
