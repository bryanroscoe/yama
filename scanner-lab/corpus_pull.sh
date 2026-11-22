#!/bin/sh
# Pull Yama's shared scan photos, the scanner's training corpus, from the server into a lab data
# folder outside the repository (docs/scanner.md, "Scan photos"; README.md, "Inputs").
#
#   sh <lab>/corpus_pull.sh [--dest DIR] [--since DATE] [--all]
#
# On the server (saget: its address comes from deploy/target.sh, so ~/.config/yama/deploy.env) it
# runs `yama-server scan-samples-export` in the yama container into a folder of its own under the
# data directory, streams that here over ssh, and removes it. Here, corpus_merge.py moves the photos
# and crops into DIR and keeps manifest.jsonl one line per photo, its newest.
#
#   --dest DIR    where the corpus lives: SCANNER_CORPUS_DIR, else data/corpus in the current work
#                 directory (run the lab from a work directory outside the repository). Made mode
#                 700, its files 600: these are people's photos. Refused inside a git checkout.
#   --since DATE  only photos made or relabelled from DATE (2026-11-22, or a moment). Without it, a
#                 folder that was pulled before takes what's new since that pull (DIR/.last-pull,
#                 less five minutes); a new folder takes everything.
#   --all         everything, whatever was pulled before.
#
# Never commit the corpus, copy it anywhere public, or send it to another service.
set -eu
umask 077

LAB_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$LAB_DIR/../deploy
. "$DEPLOY_DIR/target.sh"
# The yama container's /data on the server (deploy/compose.yaml; as deploy/pull-db.sh).
HOST_DATA=/mnt/user/appdata/yama/data

DEST=${SCANNER_CORPUS_DIR:-data/corpus}
SINCE=
ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST=${2:?--dest needs a folder}; shift 2 ;;
    --since) SINCE=${2:?--since needs a date}; shift 2 ;;
    --all) ALL=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$SINCE" in
  ''|[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*) ;;
  *) echo "--since takes a date such as 2026-11-22" >&2; exit 2 ;;
esac
case "$SINCE" in
  *[!0-9TZ:.+-]*) echo "--since takes a date such as 2026-11-22" >&2; exit 2 ;;
esac

mkdir -p "$DEST"
chmod 700 "$DEST"
DEST=$(CDPATH='' cd -- "$DEST" && pwd)
if git -C "$DEST" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "$DEST is inside a git checkout. The corpus is people's photos: keep it outside every repository." >&2
  exit 1
fi

if [ -z "$SINCE" ] && [ "$ALL" = 0 ] && [ -f "$DEST/.last-pull" ]; then
  # Five minutes before the last pull began, by the server's clock: what was being saved then too.
  SINCE=$(python3 -c 'import datetime, sys; t = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ"); print((t - datetime.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$(cat "$DEST/.last-pull")")
fi

# The server's own time, before the export starts: the next pull's starting point.
STARTED=$(ssh "$HOST" 'date -u +%Y-%m-%dT%H:%M:%SZ')
case "$STARTED" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z) ;;
  *) echo "The server didn't say what time it is: $STARTED" >&2; exit 1 ;;
esac
NAME=scan-corpus-$(printf '%s' "$STARTED" | tr -dc '0-9')-$$
REMOTE=$HOST_DATA/exports/$NAME
INCOMING=$DEST/.incoming-$NAME
cleanup() {
  # Only the folder this pull made, on the server and here.
  ssh "$HOST" "rm -rf -- '$REMOTE'" || echo "Couldn't remove $REMOTE on the server: remove it by hand." >&2
  rm -rf -- "$INCOMING"
}
trap cleanup EXIT INT TERM

echo "Exporting on the server${SINCE:+ (made or relabelled since $SINCE)}…"
ssh "$HOST" "docker exec yama yama-server scan-samples-export '/data/exports/$NAME' ${SINCE:+--since '$SINCE'}"
mkdir -p "$INCOMING"
ssh "$HOST" "tar -C '$REMOTE' -cf - ." | tar -xf - -C "$INCOMING"
python3 "$LAB_DIR/corpus_merge.py" "$DEST" "$INCOMING"
printf '%s\n' "$STARTED" > "$DEST/.last-pull"
chmod -R go-rwx "$DEST"
echo "The corpus is in $DEST (export SCANNER_REAL_DIR=$DEST for the lab's scripts)."
