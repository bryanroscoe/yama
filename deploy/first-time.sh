#!/bin/sh
# One-time server setup for Yama on saget. Changes the server: run only with Bryan's go.
set -eu
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama
CARD_DATA=card-data-2905717cc9fe0f53.json
SHA=2905717cc9fe0f53549f113f0991e998ccd969c56357f07deba5efcd0f1fc76a
cd "$(dirname "$0")"

ssh "$HOST" "mkdir -p $DIR/data/engine && chown -R 99:100 $DIR/data"
if ssh "$HOST" "test -f $DIR/yama.env"; then
  echo "yama.env already on the server; leaving it."
else
  scp -q yama.env.example "$HOST:$DIR/yama.env"
  echo "Copied yama.env.example to $DIR/yama.env; fill in the Cloudflare Access values there."
fi
# The rules engine's card data, pinned by hash. Since 2026-10-25 it's built by Yama's own pinned
# parser (deploy/phase-rev), so it isn't on data.phase-rs.dev: copy it from this checkout's
# data/engine/ (docs/engine-integration.md has the recipe and the inputs bundle that rebuild it).
if ! ssh "$HOST" "cd $DIR/data/engine && echo '$SHA  $CARD_DATA' | sha256sum -c --quiet 2>/dev/null"; then
  [ -f "../data/engine/$CARD_DATA" ] || { echo "No ../data/engine/$CARD_DATA here; build it (docs/engine-integration.md) or copy it from a machine that has it."; exit 1; }
  scp -q "../data/engine/$CARD_DATA" "$HOST:$DIR/data/engine/$CARD_DATA"
  ssh "$HOST" "cd $DIR/data/engine && echo '$SHA  $CARD_DATA' | sha256sum -c"
fi
ssh "$HOST" "chown 99:100 $DIR/data/engine/$CARD_DATA"
echo "Server prepared. Next: ./deploy.sh"
