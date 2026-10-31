#!/bin/bash
# Put the shared API key for "Ask Claude" on saget, so accounts an admin grants it (Admin, People,
# "Ask Claude on the shared key", or `yama-server advisor share EMAIL`) can ask on it. Only Bryan
# can do this.
#
# This is NOT the Claude subscription. Anthropic doesn't allow sharing someone's subscription with
# other people, so this is a separate Anthropic API key that is billed per use, to Bryan:
#   1. At console.anthropic.com, sign in, make (or pick) a workspace for Yama and create an API
#      key in it (it starts with sk-ant-api).
#   2. Set a monthly spend limit there too (the Console's Limits settings, for that workspace or
#      the whole organization). Yama also stops shared questions at
#      YAMA_ADVISOR_SHARED_MONTHLY_USD (yama.env, $10 by default), from the cost each answer
#      reports; the Console's limit is the backstop for anything that slips past.
#   3. Run this script and paste the key when it asks.
# The key stays hidden while you paste it, travels to saget over SSH's stdin (never in a command
# line, a log or git), and is written to the advisor's own settings file
# (/mnt/user/appdata/yama/advisor.env, mode 0600) as ANTHROPIC_SHARED_API_KEY. Then the advisor
# restarts. The yama server never sees the key; the advisor only says whether it has one.
#
# Run it again with a new key to replace it, or with `--remove` to take it off the server (granted
# accounts then see the usual "add your own key").
#
# This changes the server: run it only when Bryan says to.
set -eu
DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)
. "$DEPLOY_DIR/target.sh"
DIR=/mnt/user/appdata/yama

if [ "${1:-}" = "--remove" ]; then
  ssh "$HOST" "cd $DIR && umask 077 && touch advisor.env && { grep -v '^ANTHROPIC_SHARED_API_KEY=' advisor.env || true; } > advisor.env.new && \
    mv advisor.env.new advisor.env && chmod 600 advisor.env && \
    docker compose up -d --force-recreate yama-advisor >/dev/null && echo 'The shared API key is removed and the advisor restarted.'"
  exit 0
fi

trap 'stty echo 2>/dev/null || true' EXIT INT TERM
printf 'Paste the API key from console.anthropic.com (it stays hidden), then press Return: '
IFS= read -rs KEY
printf '\n'
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')
case "$KEY" in
  sk-ant-api*) ;;
  sk-ant-oat*) echo "That's a subscription token (from claude setup-token), not an API key. Sharing the subscription isn't allowed; make an API key at console.anthropic.com. Nothing was changed."; exit 1 ;;
  *) echo "That doesn't look like an Anthropic API key (they start with sk-ant-api). Nothing was changed."; exit 1 ;;
esac

printf '%s' "$KEY" | ssh "$HOST" "cd $DIR && umask 077 && touch advisor.env && \
  { grep -v '^ANTHROPIC_SHARED_API_KEY=' advisor.env || true; } > advisor.env.new && \
  { printf 'ANTHROPIC_SHARED_API_KEY='; cat; printf '\n'; } >> advisor.env.new && \
  mv advisor.env.new advisor.env && chmod 600 advisor.env && \
  docker compose up -d --force-recreate yama-advisor >/dev/null && \
  echo 'Done: the advisor restarted with the shared key. Grant accounts in Admin, People, or with yama-server advisor share EMAIL.'"
unset KEY
