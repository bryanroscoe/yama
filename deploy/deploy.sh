#!/bin/sh
# Build Yama on saget's Docker daemon (over SSH) and restart the container.
# Without --check this changes the server: only run it when Bryan has said to deploy.
set -eu
cd "$(dirname "$0")/.."
CHECK_ONLY=0
case "$#:$*" in
  0:) ;;
  1:--check) CHECK_ONLY=1 ;;
  *) echo "Usage: ./deploy/deploy.sh [--check]" >&2; exit 1 ;;
esac
# No server calls until main has been refreshed from GitHub and verified. Keep the exact
# verified commit throughout the build, even if another local thread moves HEAD later.
RELEASE_REV=$(sh ./deploy/check-release.sh)
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama
REV=$(git rev-parse --short "$RELEASE_REV")
# Deploys build committed code only (2026-10-24): Yama at HEAD and the engine at the commit pinned
# in deploy/phase-rev, both exported with git archive. Several agents work in these checkouts at
# once, so copying working files could ship someone's unfinished edits; this way the same commits
# always build the same server. The release check refuses uncommitted changes.
DIRTY=0
PHASE_REV=$(git show "$RELEASE_REV:deploy/phase-rev" | tr -d '[:space:]')
git -C ../yama-phase cat-file -e "$PHASE_REV^{commit}" 2>/dev/null || { echo "deploy/phase-rev ($PHASE_REV) isn't a commit in ../yama-phase."; exit 1; }
if [ "$CHECK_ONLY" = 1 ]; then
  echo "Ready to deploy main at $REV with phase $PHASE_REV. Check only; saget was not contacted."
  exit 0
fi
SRC=$(mktemp -d "${TMPDIR:-/tmp}/yama-deploy.XXXXXX")
trap 'rm -rf "$SRC"' EXIT
mkdir -p "$SRC/yama" "$SRC/yama-phase"
git archive "$RELEASE_REV" | tar -x -C "$SRC/yama"
git -C ../yama-phase archive "$PHASE_REV" Cargo.toml crates | tar -x -C "$SRC/yama-phase"

echo "Copying source to saget (yama $REV, phase $(echo "$PHASE_REV" | cut -c1-7))…"
ssh "$HOST" "mkdir -p $DIR/build/yama $DIR/build/yama-phase"
# The build runs on saget itself (detached), so a dropped SSH connection can't kill it.
rsync -a --delete "$SRC/yama/" "$HOST:$DIR/build/yama/"
rsync -a --delete "$SRC/yama-phase/" "$HOST:$DIR/build/yama-phase/"

echo "Building yama:$REV on saget (log: $DIR/build/build.log)…"
ssh "$HOST" "cd $DIR/build && rm -f build.status && \
  nohup sh -c 'docker build -f yama/deploy/Dockerfile --build-context phase=yama-phase \
    --build-arg YAMA_GIT_SHA=$REV --build-arg YAMA_GIT_DIRTY=$DIRTY -t yama:latest -t yama:$REV yama \
    > build.log 2>&1; echo \$? > build.status' > /dev/null 2>&1 &"
while ! ssh "$HOST" "test -f $DIR/build/build.status"; do sleep 20; done
if [ "$(ssh "$HOST" "cat $DIR/build/build.status")" != "0" ]; then
  ssh "$HOST" "tail -30 $DIR/build/build.log"; echo "Build failed."; exit 1
fi

echo "Building yama-advisor:$REV on saget (log: $DIR/build/advisor-build.log)…"
if ! ssh "$HOST" "cd $DIR/build && docker build -f yama/deploy/Dockerfile.advisor -t yama-advisor:latest -t yama-advisor:$REV yama/advisor \
    > advisor-build.log 2>&1"; then
  ssh "$HOST" "tail -30 $DIR/build/advisor-build.log"; echo "Advisor build failed."; exit 1
fi

echo "Building yama-forge:$REV on saget (log: $DIR/build/forge-build.log; the first build downloads Forge)…"
# The worker's results carry its source, not Yama's commit: a pod whose two Forge games ran under
# different labels is left out of a run's difference, so a deploy that doesn't touch the worker
# mustn't change the label of games already played (2026-10-24, run b8c61ce0).
FORGE_SRC=$(git rev-parse --short=7 "$RELEASE_REV:forge-worker")
if ! ssh "$HOST" "cd $DIR/build && docker build -f yama/deploy/Dockerfile.forge-worker --build-arg FORGE_WORKER_GIT_SHA=$FORGE_SRC \
    -t yama-forge:latest -t yama-forge:$REV yama/forge-worker > forge-build.log 2>&1"; then
  ssh "$HOST" "tail -30 $DIR/build/forge-build.log"; echo "Forge worker build failed."; exit 1
fi

# The Forge worker's secret, made once on saget and never printed, shared with yama.
ssh "$HOST" "cd $DIR && umask 077 && touch forge.env && chmod 600 forge.env yama.env && \
  if ! grep -q '^FORGE_SECRET=' forge.env; then s=\$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n'); \
    printf 'FORGE_SECRET=%s\\n' \"\$s\" >> forge.env; \
    grep -v '^YAMA_FORGE_SECRET=' yama.env > yama.env.new; printf 'YAMA_FORGE_SECRET=%s\\n' \"\$s\" >> yama.env.new; mv yama.env.new yama.env; fi && \
  { grep -q '^YAMA_FORGE_URL=' yama.env || printf '\\n# Forge as a second Lab engine (the Forge worker), added by deploy.sh\\nYAMA_FORGE_URL=http://yama-forge:8791\\n' >> yama.env; }"

# The advisor's secrets, made once on saget and never printed: the secret yama and the sidecar
# share, the key that encrypts users' own API keys, and whose account uses the subscription (the
# first admin email; Anthropic doesn't allow sharing a subscription with other people). Bryan's
# subscription token itself only ever comes from deploy/advisor-token.sh.
ssh "$HOST" "cd $DIR && umask 077 && touch advisor.env && chmod 600 advisor.env yama.env && \
  rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n'; } && \
  if ! grep -q '^ADVISOR_SECRET=' advisor.env; then s=\$(rand); printf 'ADVISOR_SECRET=%s\\n' \"\$s\" >> advisor.env; \
    grep -v '^YAMA_ADVISOR_SECRET=' yama.env > yama.env.new; printf 'YAMA_ADVISOR_SECRET=%s\\n' \"\$s\" >> yama.env.new; mv yama.env.new yama.env; fi && \
  { grep -q '^YAMA_ADVISOR_URL=' yama.env || printf '\\n# Ask Claude (the advisor sidecar), added by deploy.sh\\nYAMA_ADVISOR_URL=http://yama-advisor:8790\\n' >> yama.env; } && \
  { grep -q '^YAMA_ADVISOR_KEY_SECRET=' yama.env || printf 'YAMA_ADVISOR_KEY_SECRET=%s\\n' \"\$(rand)\" >> yama.env; } && \
  { grep -q '^YAMA_ADVISOR_TOOLS_URL=' yama.env || printf 'YAMA_ADVISOR_TOOLS_URL=http://yama:8787/mcp\\n' >> yama.env; } && \
  { grep -q '^YAMA_ADVISOR_SUBSCRIPTION_EMAILS=' yama.env || \
    printf 'YAMA_ADVISOR_SUBSCRIPTION_EMAILS=%s\\n' \"\$(sed -n 's/^YAMA_ADMIN_EMAILS=\\([^,]*\\).*/\\1/p' yama.env | head -1)\" >> yama.env; }"

echo "Backing up the database, then restarting…"
scp -q "$SRC/yama/deploy/compose.yaml" "$HOST:$DIR/compose.yaml"
STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "cd $DIR && mkdir -p data/backups && chown 99:100 data/backups && \
  (docker exec yama yama-server backup /data/backups/yama-$STAMP.db || echo 'no running yama to back up') && \
  docker compose up -d && sleep 5 && docker ps --filter name=^yama --format '{{.Names}}: {{.Status}}'"
echo "Done: yama:$REV. LAN http://<saget-lan-address>:8099"
