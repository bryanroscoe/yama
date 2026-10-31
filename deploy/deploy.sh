#!/bin/sh
# Manual releases use the same server-owned lock and CI gate as GitHub Actions.
set -eu
DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DEPLOY_DIR/.."
case "$#:$*" in
  0:) CHECK_ONLY=0 ;;
  1:--check) CHECK_ONLY=1 ;;
  *) echo "Usage: ./deploy/deploy.sh [--check]" >&2; exit 1 ;;
esac
RELEASE_REV=$(sh ./deploy/check-release.sh)
sh ./deploy/check-phase.sh "$RELEASE_REV" >/dev/null
if [ "$CHECK_ONLY" = 1 ]; then
  echo "Ready to deploy main at $RELEASE_REV. Check only; saget was not contacted."
  exit 0
fi
. "$DEPLOY_DIR/target.sh"
# A short-lived workflow token or the current gh login. Never put it in arguments,
# files, build contexts or logs. The server verifies current main and CI itself.
TOKEN=${GH_TOKEN:-${GITHUB_TOKEN:-}}
if [ -z "$TOKEN" ]; then TOKEN=$(gh auth token); fi
printf '%s\n' "$TOKEN" | ssh -T "$HOST" \
  "/mnt/user/appdata/yama-release/host.py deploy $RELEASE_REV"
