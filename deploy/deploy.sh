#!/bin/sh
# Build Yama on saget's Docker daemon (over SSH) and restart the container.
# Every run changes the server: only run it when Bryan has said to deploy.
set -eu
cd "$(dirname "$0")/.."
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama
REV=$(git rev-parse --short HEAD)
# Whether the copied source differs from that commit (shown on the admin area's Server page).
DIRTY=0
if [ -n "$(git status --porcelain --untracked-files=no -- server play web packages Cargo.toml Cargo.lock)" ]; then DIRTY=1; fi

echo "Copying source to saget…"
ssh "$HOST" "mkdir -p $DIR/build/yama $DIR/build/yama-phase"
# The build runs on saget itself (detached), so a dropped SSH connection can't kill it.
rsync -a --delete --exclude target --exclude node_modules --exclude data --exclude .git \
  --exclude web/dist --exclude web/public/ocr --exclude .env ./ "$HOST:$DIR/build/yama/"
rsync -a --delete --include Cargo.toml --include 'crates/***' --exclude '*' ../yama-phase/ "$HOST:$DIR/build/yama-phase/"

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
scp -q deploy/compose.yaml "$HOST:$DIR/compose.yaml"
STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "cd $DIR && mkdir -p data/backups && chown 99:100 data/backups && \
  (docker exec yama yama-server backup /data/backups/yama-$STAMP.db || echo 'no running yama to back up') && \
  docker compose up -d && sleep 5 && docker ps --filter name=^yama --format '{{.Names}}: {{.Status}}'"
echo "Done: yama:$REV. LAN http://<saget-lan-address>:8099"
