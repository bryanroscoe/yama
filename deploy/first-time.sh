#!/bin/sh
# Fixed client-side paths/hashes intentionally expand into the remote commands.
# shellcheck disable=SC2029
# One-time server setup for Yama on saget. Changes the server: run only with Bryan's go.
set -eu
DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$DEPLOY_DIR/target.sh"
DIR=/mnt/user/appdata/yama
CARD_DATA=card-data-19b30ee31fc29d11.json
SHA=19b30ee31fc29d11df4edfb02ecc9543c4facb17c635b17dfd5347c81462a630
HISTORICAL_CARD_DATA=card-data-1e5608e61683de41.json
HISTORICAL_SHA=1e5608e61683de41c84f08f70115bef38db13df85bc5e01fd0eb249cf023244d
cd "$DEPLOY_DIR"

ssh "$HOST" "mkdir -p $DIR/data/engine && chown -R 99:100 $DIR/data"
if ssh "$HOST" "if test -f $DIR/yama.env; then exit 0; else exit 10; fi"; then
  echo "yama.env already on the server; leaving it."
else
  check_status=$?
  [ "$check_status" -eq 10 ] || { echo "Could not check the server configuration; stopping without replacing it."; exit "$check_status"; }
  scp -q yama.env.example "$HOST:$DIR/yama.env"
  echo "Copied yama.env.example to $DIR/yama.env; configure the verified Google sign-in values there."
fi
# The rules engine's card data, pinned by hash. Since 2026-10-25 it's built by Yama's own pinned
# parser (deploy/phase-rev), so it isn't on data.phase-rs.dev: copy it from this checkout's
# data/engine/ (docs/engine-integration.md has the recipe and the inputs bundle that rebuild it).
# Both are required by the release preflight, including on a new server. The
# historical export must retain its original bytes; do not regenerate it with
# the current parser. Correct remote files are reused without a local copy.
staged_path=
cleanup_stage() {
  if [ -n "$staged_path" ]; then
    ssh "$HOST" "rm -f -- '$staged_path'" || true
  fi
}
trap cleanup_stage EXIT
trap 'exit 1' HUP INT TERM
stage_card_data() {
  card_file=$1
  card_sha=$2
  if ssh "$HOST" "cd $DIR/data/engine && if echo '$card_sha  $card_file' | sha256sum -c --quiet 2>/dev/null; then exit 0; else exit 10; fi"; then
    : # A verified artifact needs no replacement.
  else
    check_status=$?
    [ "$check_status" -eq 10 ] || { echo "Could not check $card_file on the server; no artifact replaced."; exit "$check_status"; }
    [ -f "../data/engine/$card_file" ] || { echo "No ../data/engine/$card_file here; copy the exact pinned artifact from a machine that has it (docs/engine-integration.md)."; exit 1; }
    candidate_path=$(ssh "$HOST" "mktemp '$DIR/data/engine/.$card_file.XXXXXX'")
    # Only use the expected mktemp result in subsequent remote shell commands.
    case "$candidate_path" in
      "$DIR/data/engine/.$card_file."[a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9]) staged_path=$candidate_path ;;
      *) echo "Unexpected staging path; no artifact replaced."; exit 1 ;;
    esac
    scp -q "../data/engine/$card_file" "$HOST:$staged_path"
    # Refuse malformed destinations; GNU -T also prevents directory semantics
    # if the destination changes between this check and the atomic rename.
    ssh "$HOST" "echo '$card_sha  $staged_path' | sha256sum -c && chown 99:100 '$staged_path' && test ! -d '$DIR/data/engine/$card_file' && test ! -L '$DIR/data/engine/$card_file' && mv -fT -- '$staged_path' '$DIR/data/engine/$card_file'"
    staged_path=
  fi
  ssh "$HOST" "chown 99:100 $DIR/data/engine/$card_file"
}
stage_card_data "$CARD_DATA" "$SHA"
stage_card_data "$HISTORICAL_CARD_DATA" "$HISTORICAL_SHA"
echo "Server prepared. Configure yama.env, then follow deploy/RUNNER.md to enable current-main CI deployments."
