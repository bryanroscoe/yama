#!/bin/sh
# Check the live server's health over the LAN. Reads saget's address the same way the other
# deploy scripts do (environment, then the gitignored deploy/.env), so no address is tracked.
set -eu
DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$DEPLOY_DIR/target.sh"
exec curl -fsS "http://$YAMA_DEPLOY_HOST:8099/api/health"
