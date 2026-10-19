#!/bin/sh
# One-time server setup for Yama on saget. Changes the server: run only with Bryan's go.
set -eu
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama
CARD_DATA=card-data-eb309108eb0df708.json
SHA=eb309108eb0df708b6cb5b3c75858149a9fd2864ee0f4ef81195cc75af058b85
cd "$(dirname "$0")"

ssh "$HOST" "mkdir -p $DIR/data/engine && chown -R 99:100 $DIR/data"
if ssh "$HOST" "test -f $DIR/yama.env"; then
  echo "yama.env already on the server; leaving it."
else
  scp -q yama.env.example "$HOST:$DIR/yama.env"
  echo "Copied yama.env.example to $DIR/yama.env; fill in the Cloudflare Access values there."
fi
# The rules engine's card data, pinned by hash.
ssh "$HOST" "cd $DIR/data/engine && \
  ( echo '$SHA  $CARD_DATA' | sha256sum -c --quiet 2>/dev/null || \
    ( curl -fsSL -A 'Yama/0.1 (private)' -o $CARD_DATA https://data.phase-rs.dev/$CARD_DATA && \
      echo '$SHA  $CARD_DATA' | sha256sum -c ) ) && chown 99:100 $CARD_DATA"
echo "Server prepared. Next: ./deploy.sh"
