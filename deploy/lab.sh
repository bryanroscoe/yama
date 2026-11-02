#!/bin/sh
# Simulation runs on saget, separate from the yama container (which this never touches).
# Every command except "status" changes the server; Bryan approved lab runs on saget (2026-10-18).
#
#   deploy/lab.sh build                      copy source, build yama-lab:<rev> on saget
#   deploy/lab.sh decks <dir>                copy a deck directory (e.g. commander-decks/data/sim/decks)
#   deploy/lab.sh start <run> <schedule> <threads>
#                                            copy the schedule and start container yama-lab-<run>
#   deploy/lab.sh status <run>               progress: results so far, container state
#   deploy/lab.sh pull <run> <dest-dir>      copy results-saget.jsonl back
#   deploy/lab.sh stop <run>                 stop and remove the container (results stay)
#
# Runs resume: the runner skips games already in its results file (--skip-done), and the
# container restarts on failure. After a hung game the runner restarts itself in a clean process
# (see lab.rs); exit code 4 means some games were not played because their decks didn't load:
# fix the deck directory ("decks") and start the run again, and only those games are played.
# CPU is capped with --cpus and given a low share, so Plex and the other containers win any
# contention.
set -eu
DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$DEPLOY_DIR/.."
. "$DEPLOY_DIR/target.sh"
DIR=/mnt/user/appdata/yama-lab
CARDS=/mnt/user/appdata/yama/data/engine
CARD_FILE=card-data-cbd552b41f962f5b.json

cmd=${1:-}
case "$cmd" in
build)
  REV=$(git rev-parse --short HEAD)
  FULL_REV=$(git rev-parse HEAD)
  PHASE_REV=$(git show HEAD:deploy/phase-rev | tr -d '[:space:]')
  PHASE_DIR=$(sh ./deploy/check-phase.sh HEAD)
  PHASE_SRC=$(mktemp -d "${TMPDIR:-/tmp}/yama-lab-phase.XXXXXX")
  trap 'rm -rf "$PHASE_SRC"' EXIT
  git -C "$PHASE_DIR" archive "$PHASE_REV" Cargo.toml crates protocol | tar -x -C "$PHASE_SRC"
  # The source goes over without .git, so the runner stamp (play/build.rs) gets the commit and
  # whether the runner's sources differ from it as build args; build.rs adds the source hash.
  DIRTY=0
  if [ -n "$(git status --porcelain -- play Cargo.toml Cargo.lock server/src server/resources \
    server/migrations server/build.rs server/Cargo.toml runtime/historical.json \
    runtime/historical-source.json deploy/phase-rev)" ]; then DIRTY=1; fi
  ssh "$HOST" "mkdir -p $DIR/build/yama $DIR/build/yama-phase $DIR/decks $DIR/runs && chown 99:100 $DIR/runs"
  rsync -a --delete --exclude target --exclude node_modules --exclude data --exclude .git \
    --exclude web --exclude .env ./ "$HOST:$DIR/build/yama/"
  rsync -a --delete "$PHASE_SRC/" "$HOST:$DIR/build/yama-phase/"
  echo "Building yama-lab:$REV on saget (log: $DIR/build/build.log)…"
  ssh "$HOST" "cd $DIR/build && rm -f build.status && \
    nohup sh -c 'docker build -f yama/deploy/Dockerfile.lab --build-context phase=yama-phase \
      --build-arg YAMA_LAB_GIT_SHA=$FULL_REV --build-arg YAMA_LAB_GIT_DIRTY=$DIRTY \
      --build-arg YAMA_PHASE_SOURCE_REV=$PHASE_REV -t yama-lab:latest -t yama-lab:$REV yama \
      > build.log 2>&1; echo \$? > build.status' > /dev/null 2>&1 &"
  while ! ssh "$HOST" "test -f $DIR/build/build.status"; do sleep 20; done
  if [ "$(ssh "$HOST" "cat $DIR/build/build.status")" != "0" ]; then
    ssh "$HOST" "tail -30 $DIR/build/build.log"; echo "Build failed."; exit 1
  fi
  echo "Built yama-lab:$REV (uncommitted runner changes: $DIRTY)"
  ;;
decks)
  src=${2:?deck directory}
  rsync -a --delete "$src/" "$HOST:$DIR/decks/"
  echo "Decks copied to $DIR/decks"
  ;;
start)
  run=${2:?run name}; schedule=${3:?schedule file}; threads=${4:?threads}
  ssh "$HOST" "mkdir -p $DIR/runs/$run && chown 99:100 $DIR/runs/$run"
  scp -q "$schedule" "$HOST:$DIR/runs/$run/schedule.jsonl"
  ssh "$HOST" "chown 99:100 $DIR/runs/$run/schedule.jsonl && docker rm -f yama-lab-$run >/dev/null 2>&1; \
    docker run -d --name yama-lab-$run --restart on-failure:20 \
      --cpus $threads --cpu-shares 256 --memory 10g \
      --user 99:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --network none \
      -v $CARDS:/engine:ro -v $DIR/decks:/decks:ro -v $DIR/runs/$run:/run \
      yama-lab:latest --card-data /engine/$CARD_FILE --decks-root /decks \
        --schedule /run/schedule.jsonl --out /run/results-saget.jsonl --threads $threads --skip-done"
  echo "Started yama-lab-$run with $threads threads"
  ;;
status)
  run=${2:?run name}
  ssh "$HOST" "printf 'scheduled: '; wc -l < $DIR/runs/$run/schedule.jsonl; printf 'done: '; \
    (wc -l < $DIR/runs/$run/results-saget.jsonl) 2>/dev/null || echo 0; \
    docker ps -a --filter name=^yama-lab-$run\$ --format '{{.Names}}: {{.Status}}'; \
    docker logs --tail 3 yama-lab-$run 2>&1"
  ;;
pull)
  run=${2:?run name}; dest=${3:?destination directory}
  mkdir -p "$dest"
  scp -q "$HOST:$DIR/runs/$run/results-saget.jsonl" "$dest/results-saget.jsonl"
  echo "Pulled to $dest/results-saget.jsonl"
  ;;
stop)
  run=${2:?run name}
  ssh "$HOST" "docker rm -f yama-lab-$run"
  ;;
*)
  sed -n '2,19p' "$0"; exit 1
  ;;
esac
