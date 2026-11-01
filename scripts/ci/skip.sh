#!/usr/bin/env bash
# Skip PR CI that is queued or too slow, once the checks have passed locally.
#
#   scripts/ci/skip.sh <pr-number> "<what you ran locally>"
#
# Labels the PR `skip-ci`, cancels its unfinished CI run, re-runs it so the Local CI
# gate reads the label (a few seconds), and records the reason on the PR. Push CI on
# main still runs every check before deployment. Remove the label to get CI back.
set -euo pipefail

if [ $# -ne 2 ] || [[ ! "$1" =~ ^[0-9]+$ ]] || [ -z "$2" ]; then
  echo 'usage: scripts/ci/skip.sh <pr-number> "<what you ran locally>"' >&2
  exit 2
fi
pr="$1"
reason="$2"

gh label create skip-ci --color BFD4F2 \
  --description 'Skip PR CI; checks ran locally (scripts/ci/skip.sh)' >/dev/null 2>&1 || true
gh pr edit "$pr" --add-label skip-ci >/dev/null

read -r branch head < <(gh pr view "$pr" --json headRefName,headRefOid --jq '"\(.headRefName) \(.headRefOid)"')
run="$(gh run list --workflow CI --event pull_request --branch "$branch" --limit 20 \
  --json databaseId,headSha --jq "[.[] | select(.headSha == \"$head\")][0].databaseId // empty")"
if [ -z "$run" ]; then
  echo "No CI run for ${head:0:12}; the label applies at the next push or when the PR is marked ready."
else
  if [ "$(gh run view "$run" --json status --jq .status)" != completed ]; then
    gh run cancel "$run" >/dev/null || true
    for _ in $(seq 60); do
      [ "$(gh run view "$run" --json status --jq .status)" = completed ] && break
      sleep 2
    done
  fi
  gh run rerun "$run"
  echo "Re-ran CI run $run; the gate skips the web and Rust jobs."
fi

gh pr comment "$pr" --body "CI skipped for \`${head:0:12}\` with the \`skip-ci\` label. Checked locally: $reason" >/dev/null
echo "PR #$pr: skip-ci recorded."
