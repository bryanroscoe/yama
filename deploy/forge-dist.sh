#!/bin/sh
# Put the Forge build that deploy/Dockerfile.forge-worker pins on saget, as the local image yama-forge-dist:<name>
# its build reads. The tarball is Forge code (GPL-3.0), built outside Yama by forge-referee's
# dist/build-dist.sh <name> <forge checkout> (default output ~/Developer/forge-engine/forge-dist-<name>.tar.gz).
#
#   deploy/forge-dist.sh status          is the pinned Forge image on saget?
#   deploy/forge-dist.sh install [TAR]   copy the tarball to saget and build the image
#
# Install it before merging a change to the pin: the release build fails without it (and keeps production).
# "install" changes the server (an image and $DIR/forge-dist/<name>); it restarts nothing.
set -eu
DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DEPLOY_DIR/.."
. "$DEPLOY_DIR/target.sh"
NAME=$(sed -n 's/^ARG FORGE_DIST=//p' deploy/Dockerfile.forge-worker)
SHA=$(sed -n 's/^ARG FORGE_DIST_SHA256=//p' deploy/Dockerfile.forge-worker)
[ -n "$NAME" ] && [ -n "$SHA" ] || { echo "no FORGE_DIST / FORGE_DIST_SHA256 pin in deploy/Dockerfile.forge-worker"; exit 1; }
DIR=/mnt/user/appdata/yama/forge-dist/$NAME
IMAGE=yama-forge-dist:$NAME
FILE=forge-dist-$NAME.tar.gz

case "${1:-}" in
status)
  ssh "$HOST" "docker image inspect $IMAGE --format '$IMAGE {{.Id}} {{.Created}}' 2>/dev/null || echo '$IMAGE is not on saget'; \
    sha256sum $DIR/$FILE 2>/dev/null || true"
  echo "pinned: $NAME $SHA"
  ;;
install)
  TAR=${2:-$HOME/Developer/forge-engine/$FILE}
  [ -f "$TAR" ] || { echo "no $TAR (build it with forge-referee dist/build-dist.sh, or pass the tarball)"; exit 1; }
  GOT=$(shasum -a 256 "$TAR" | cut -d' ' -f1)
  [ "$GOT" = "$SHA" ] || { echo "$TAR: SHA-256 $GOT, but the Dockerfile pins $SHA"; exit 1; }
  ssh "$HOST" "mkdir -p $DIR"
  scp -q "$TAR" "$HOST:$DIR/$FILE"
  ssh "$HOST" "cd $DIR && echo '$SHA  $FILE' | sha256sum -c - >/dev/null && \
    printf 'FROM scratch\nCOPY $FILE /forge-dist.tar.gz\n' > Dockerfile && \
    docker build -q -t $IMAGE . && docker image inspect $IMAGE --format '$IMAGE {{.Id}}'"
  ;;
*)
  sed -n '2,10p' "$0"; exit 1
  ;;
esac
