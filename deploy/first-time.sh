#!/bin/sh
# Fixed client-side paths/hashes intentionally expand into the remote commands.
# shellcheck disable=SC2029
# One-time server setup for Yama on saget. Changes the server: run only with Bryan's go.
set -eu
DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$DEPLOY_DIR/target.sh"
DIR=/mnt/user/appdata/yama
CARD_DATA=card-data-1e5608e61683de41.json
SHA=1e5608e61683de41c84f08f70115bef38db13df85bc5e01fd0eb249cf023244d
cd "$DEPLOY_DIR"

ssh "$HOST" "mkdir -p $DIR/data/engine && chown -R 99:100 $DIR/data"
if ssh "$HOST" "test -f $DIR/yama.env"; then
  echo "yama.env already on the server; leaving it."
else
  scp -q yama.env.example "$HOST:$DIR/yama.env"
  echo "Copied yama.env.example to $DIR/yama.env; configure the verified Google sign-in values there."
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
echo "Server prepared. Configure yama.env, then follow deploy/RUNNER.md to enable current-main CI deployments."
