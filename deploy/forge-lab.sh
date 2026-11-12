#!/bin/sh
# Forge deck lab runs on saget: the lab's second engine (commander-decks scripts/sim/forge_runner.py, notes in
# commander-decks docs/lab/forge.md), separate from the yama container and the phase lab (deploy/lab.sh), which
# this never touches. Every command except "status" changes the server; Bryan approved lab runs on saget (2026-10-18).
#
#   deploy/forge-lab.sh build                copy the runner from commander-decks, build forge-lab:<tag> on saget
#   deploy/forge-lab.sh decks <dir>          copy a deck directory (e.g. commander-decks/data/sim/decks)
#   deploy/forge-lab.sh start <run> <schedule> <threads> [cpus]
#                                            copy the schedule and start container forge-lab-<run>
#   deploy/forge-lab.sh status <run>         progress: results so far, end kinds, container state and memory
#   deploy/forge-lab.sh pull <run> <dest-dir> [logs-dir]
#                                            copy results-saget.jsonl, forge-stats-saget.jsonl and forge-saget.log
#                                            back (and the kept logs of unusual games to logs-dir, if given)
#   deploy/forge-lab.sh stop <run>           stop and remove the container (results stay)
#
# One JVM per game, <threads> games at once. The CPU cap defaults to 2 x threads (at most 16): Forge's game limit
# and its 5 s per AI decision are wall-clock, so a throttled container gets more time_cap games and more AI
# time-outs (which change the game). Smoke test 2026-10-19, 12 games on 6 threads: with --cpus 9 the container was
# throttled in 36% of periods, games averaged 281 s and one hit the 900 s limit; with --cpus 12, 4.5%, 219 s, none.
# Low --cpu-shares, so Plex and the other containers win any contention.
# Memory: games peaked at 0.8-1.3 GB each on saget (-Xmx1536m). Each JVM gets -Xmx$FORGE_XMX_MB (default 1536)
# and the container threads x (heap + 512 MB) + 1 GB, so the JVMs together can't reach the cap.
# Runs resume: the runner skips games already in its results file (--skip-done), and the container restarts on
# failure. Games in progress when the container stops aren't written, so they are played again. Exit code 4 means
# some games weren't played (a deck file didn't load) or were written as deck errors (cards Forge doesn't know):
# fix the deck directory ("decks") and start the run again; those games are replayed.
# Extra runner flags: FORGE_ARGS="--max-seconds 1800" deploy/forge-lab.sh start ...
set -eu
DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$DEPLOY_DIR/.."
. "$DEPLOY_DIR/target.sh"
DIR=/mnt/user/appdata/yama-lab/forge
CD=${COMMANDER_DECKS:-../commander-decks}
FORGE_VERSION=2.0.16
XMX_MB=${FORGE_XMX_MB:-1536}

cmd=${1:-}
case "$cmd" in
build)
  [ -f "$CD/scripts/sim/forge_runner.py" ] || { echo "no $CD/scripts/sim/forge_runner.py (COMMANDER_DECKS)"; exit 1; }
  # The runner stamp: the image has no .git, so pass commander-decks' commit and whether forge_runner.py differs
  # from it (the same rule as on the Mac). The image tag also notes uncommitted changes to common.py.
  SHA=$(git -C "$CD" rev-parse --short HEAD)
  DIRTY=0
  if [ -n "$(git -C "$CD" status --porcelain -- scripts/sim/forge_runner.py)" ]; then DIRTY=1; fi
  TAG=$FORGE_VERSION-$SHA
  if [ "$DIRTY" = 1 ] || [ -n "$(git -C "$CD" status --porcelain -- scripts/sim/common.py)" ]; then
    TAG=$TAG-dirty-$(cat "$CD/scripts/sim/forge_runner.py" "$CD/scripts/sim/common.py" | shasum -a 256 | cut -c1-8)
  fi
  ssh "$HOST" "mkdir -p $DIR/build/ctx/scripts/sim $DIR/decks $DIR/runs && chown 99:100 $DIR/runs"
  rsync -a deploy/Dockerfile.forge "$HOST:$DIR/build/ctx/Dockerfile.forge"
  rsync -a "$CD/scripts/sim/forge_runner.py" "$CD/scripts/sim/common.py" "$HOST:$DIR/build/ctx/scripts/sim/"
  echo "Building forge-lab:$TAG on saget (log: $DIR/build/build.log)…"
  ssh "$HOST" "cd $DIR/build && rm -f build.status && \
    nohup sh -c 'docker build -f ctx/Dockerfile.forge --build-arg FORGE_VERSION=$FORGE_VERSION \
      --build-arg FORGE_RUNNER_GIT_SHA=$SHA --build-arg FORGE_RUNNER_GIT_DIRTY=$DIRTY \
      -t forge-lab:latest -t forge-lab:$TAG ctx > build.log 2>&1; echo \$? > build.status' > /dev/null 2>&1 &"
  while ! ssh "$HOST" "test -f $DIR/build/build.status"; do sleep 15; done
  if [ "$(ssh "$HOST" "cat $DIR/build/build.status")" != "0" ]; then
    ssh "$HOST" "tail -30 $DIR/build/build.log"; echo "Build failed."; exit 1
  fi
  ssh "$HOST" "docker run --rm --network none --entrypoint java forge-lab:latest -version 2>&1 | head -1"
  echo "Built forge-lab:$TAG (uncommitted runner changes: $DIRTY)"
  ;;
decks)
  src=${2:?deck directory}
  ssh "$HOST" "mkdir -p $DIR/decks"
  rsync -a --delete "$src/" "$HOST:$DIR/decks/"
  echo "Decks copied to $DIR/decks"
  ;;
start)
  run=${2:?run name}; schedule=${3:?schedule file}; threads=${4:?threads}
  cpus=${5:-$(( threads * 2 ))}
  if [ "$cpus" -gt 16 ]; then cpus=16; fi
  mem_mb=$(( threads * (XMX_MB + 512) + 1024 ))
  ssh "$HOST" "mkdir -p $DIR/runs/$run && chown 99:100 $DIR/runs/$run"
  scp -q "$schedule" "$HOST:$DIR/runs/$run/schedule.jsonl"
  ssh "$HOST" "chown 99:100 $DIR/runs/$run/schedule.jsonl && docker rm -f forge-lab-$run >/dev/null 2>&1; \
    docker run -d --name forge-lab-$run --init --restart on-failure:20 \
      --cpus $cpus --cpu-shares 256 --memory ${mem_mb}m \
      --user 99:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --network none \
      --tmpfs /work:rw,size=2g,uid=99,gid=100,mode=0755 --tmpfs /tmp:rw,exec,size=512m,mode=1777 \
      -e FORGE_LOG=/run/forge-saget.log \
      -v $DIR/decks:/decks:ro -v $DIR/runs/$run:/run \
      forge-lab:latest --decks-root /decks --schedule /run/schedule.jsonl --out /run/results-saget.jsonl \
        --threads $threads --xmx ${XMX_MB}m --logs-dir /run/forge-logs --skip-done ${FORGE_ARGS:-}"
  echo "Started forge-lab-$run: $threads games at once, --cpus $cpus, --memory ${mem_mb}m, -Xmx${XMX_MB}m per game"
  ;;
status)
  run=${2:?run name}
  ssh "$HOST" "R=$DIR/runs/$run; printf 'scheduled: '; wc -l < \$R/schedule.jsonl; printf 'done: '; \
    (wc -l < \$R/results-saget.jsonl) 2>/dev/null || echo 0; \
    printf 'ends:'; (grep -o '\"end\":\"[a-z_]*\"' \$R/results-saget.jsonl 2>/dev/null | cut -d'\"' -f4 | sort | uniq -c \
      | awk '{printf \" %s %s\", \$2, \$1}'); echo; \
    docker ps -a --filter name=^forge-lab-$run\$ --format '{{.Names}}: {{.Status}}'; \
    docker stats --no-stream --format 'cpu {{.CPUPerc}}, memory {{.MemUsage}}' forge-lab-$run 2>/dev/null || true; \
    tail -n 3 \$R/forge-saget.log 2>/dev/null"
  ;;
pull)
  run=${2:?run name}; dest=${3:?destination directory}; logs=${4:-}
  mkdir -p "$dest"
  for f in results-saget.jsonl forge-stats-saget.jsonl forge-saget.log; do
    scp -q "$HOST:$DIR/runs/$run/$f" "$dest/$f" || echo "no $f yet"
  done
  if [ -n "$logs" ]; then
    mkdir -p "$logs"
    rsync -a "$HOST:$DIR/runs/$run/forge-logs/" "$logs/" 2>/dev/null || echo "no kept game logs"
  fi
  echo "Pulled to $dest"
  ;;
stop)
  run=${2:?run name}
  ssh "$HOST" "docker rm -f forge-lab-$run"
  ;;
*)
  sed -n '2,27p' "$0"; exit 1
  ;;
esac
