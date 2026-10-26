#!/bin/sh
# Check the release source without touching saget. Print only the verified commit on stdout.
set -eu
cd "$(dirname "$0")/.."

fail() { echo "Release check: $*" >&2; exit 1; }
check_checkout() {
  BRANCH=$(git symbolic-ref --quiet --short HEAD) || fail "detached HEAD; switch to main."
  [ "$BRANCH" = main ] || fail "deploy from main after merging; current branch is $BRANCH."
  STATUS=$(git status --porcelain) || fail "couldn't inspect the checkout; no deployment is allowed."
  [ -z "$STATUS" ] || fail "the checkout has uncommitted or untracked files. Finish and commit the intended changes before releasing; see deploy/RELEASING.md."
}

check_checkout
# Fetch main explicitly, even if this checkout has a custom remote fetch refspec. Never rely
# on the last fetch another thread happened to run, and never deploy when GitHub is unreachable.
git fetch --prune origin '+refs/heads/main:refs/remotes/origin/main' >&2 || fail "couldn't refresh origin/main; no deployment is allowed."
check_checkout
RELEASE_REV=$(git rev-parse HEAD)
REMOTE_REV=$(git rev-parse refs/remotes/origin/main)
[ "$RELEASE_REV" = "$REMOTE_REV" ] || fail "main differs from freshly fetched origin/main. Integrate GitHub's changes, verify the merged result, and push main before deploying."
echo "Release check passed: clean main matches origin/main at $RELEASE_REV." >&2
printf '%s\n' "$RELEASE_REV"
