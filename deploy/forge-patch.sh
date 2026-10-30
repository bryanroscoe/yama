#!/bin/sh
# Put the Forge patch set that deploy/Dockerfile.forge-worker pins on saget, as the local image
# yama-forge-patch:<name> its build reads. The patch jar is compiled Forge code (GPL-3.0), kept out of Yama in
# the private forge-referee repo (patches/<name>/, ./build.sh <name>); see forge-worker/README.md.
#
#   deploy/forge-patch.sh status        is the pinned patch image on saget?
#   deploy/forge-patch.sh install [JAR] copy the jar (default: forge-referee's) to saget and build the image
#
# Install it before merging a change to the pin: the release build fails without it (and keeps production).
# "install" changes the server (an image and $DIR/forge-patch/<name>); it restarts nothing.
set -eu
cd "$(dirname "$0")/.."
HOST=root@<saget-lan-address>
NAME=$(sed -n 's/^ARG FORGE_PATCH=//p' deploy/Dockerfile.forge-worker)
SHA=$(sed -n 's/^ARG FORGE_PATCH_SHA256=//p' deploy/Dockerfile.forge-worker)
[ -n "$NAME" ] && [ -n "$SHA" ] || { echo "no FORGE_PATCH / FORGE_PATCH_SHA256 pin in deploy/Dockerfile.forge-worker"; exit 1; }
DIR=/mnt/user/appdata/yama/forge-patch/$NAME
IMAGE=yama-forge-patch:$NAME
JARNAME=forge-patch-$NAME.jar

case "${1:-}" in
status)
  ssh "$HOST" "docker image inspect $IMAGE --format '$IMAGE {{.Id}} {{.Created}}' 2>/dev/null || echo '$IMAGE is not on saget'; \
    sha256sum $DIR/$JARNAME 2>/dev/null || true"
  echo "pinned: $NAME $SHA"
  ;;
install)
  JAR=${2:-${FORGE_REFEREE:-$HOME/Developer/forge-referee}/patches/$NAME/$JARNAME}
  [ -f "$JAR" ] || { echo "no $JAR (FORGE_REFEREE, or pass the jar)"; exit 1; }
  GOT=$(shasum -a 256 "$JAR" | cut -d' ' -f1)
  [ "$GOT" = "$SHA" ] || { echo "$JAR: SHA-256 $GOT, but the Dockerfile pins $SHA"; exit 1; }
  ssh "$HOST" "mkdir -p $DIR"
  scp -q "$JAR" "$HOST:$DIR/$JARNAME"
  ssh "$HOST" "cd $DIR && echo '$SHA  $JARNAME' | sha256sum -c - >/dev/null && \
    printf 'FROM scratch\nCOPY $JARNAME /forge-patch.jar\n' > Dockerfile && \
    docker build -q -t $IMAGE . && docker image inspect $IMAGE --format '$IMAGE {{.Id}}'"
  ;;
*)
  sed -n '2,10p' "$0"; exit 1
  ;;
esac
