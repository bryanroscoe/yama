#!/bin/bash
# Connect "Ask Claude" to Bryan's Claude subscription. Only Bryan can do this: run
#   claude setup-token
# on the Mac first (it opens the browser and prints a token that lasts a year), then run this
# script and paste the token when it asks. The token stays hidden while you paste it, travels to
# saget over SSH's stdin (never in a command line, a log or git), and is written to the advisor's
# own settings file (/mnt/user/appdata/yama/advisor.env, mode 0600). Then the advisor restarts.
#
# Only accounts in YAMA_ADVISOR_SUBSCRIPTION_EMAILS (yama.env) ask on this token; Anthropic doesn't
# allow sharing one person's subscription with other people. Run it again with a new token when the
# old one expires, or with `--remove` to take the subscription off the server.
#
# This changes the server: run it only when Bryan says to.
set -eu
HOST=root@<saget-lan-address>
DIR=/mnt/user/appdata/yama

if [ "${1:-}" = "--remove" ]; then
  ssh "$HOST" "cd $DIR && umask 077 && touch advisor.env && { grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' advisor.env || true; } > advisor.env.new && mv advisor.env.new advisor.env && \
    docker compose up -d --force-recreate yama-advisor >/dev/null && echo 'The subscription token is removed and the advisor restarted.'"
  exit 0
fi

trap 'stty echo 2>/dev/null || true' EXIT INT TERM
printf 'Paste the token from `claude setup-token` (it stays hidden), then press Return: '
IFS= read -rs TOKEN
printf '\n'
TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
case "$TOKEN" in
  sk-ant-*) ;;
  *) echo "That doesn't look like a Claude token (they start with sk-ant-). Nothing was changed."; exit 1 ;;
esac

printf '%s' "$TOKEN" | ssh "$HOST" "cd $DIR && umask 077 && touch advisor.env && \
  { grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' advisor.env || true; } > advisor.env.new && \
  { printf 'CLAUDE_CODE_OAUTH_TOKEN='; cat; printf '\n'; } >> advisor.env.new && \
  mv advisor.env.new advisor.env && chmod 600 advisor.env && \
  docker compose up -d --force-recreate yama-advisor >/dev/null && \
  echo 'Connected: the advisor restarted with your subscription. Ask Claude from any plan, deck or lab page.'"
unset TOKEN
