#!/bin/sh
# Resolve only a published commit of Yama's engine repository. Never contact saget.
set -eu
cd "$(dirname "$0")/.."

fail() { echo "Phase check: $*" >&2; exit 1; }
RELEASE_REV=${1:-HEAD}
PHASE_DIR=${YAMA_PHASE_DIR:-../yama-phase}
PHASE_REPO=$(git show "$RELEASE_REV:deploy/phase-repo" | tr -d '\r\n')
PHASE_REV=$(git show "$RELEASE_REV:deploy/phase-rev" | tr -d '[:space:]')
[ -n "$PHASE_REPO" ] || fail "deploy/phase-repo is empty."
[ "${#PHASE_REV}" = 40 ] || fail "deploy/phase-rev must contain a full commit SHA."
case "$PHASE_REV" in *[!0-9a-f]*) fail "deploy/phase-rev must contain a full commit SHA." ;; esac
git -C "$PHASE_DIR" rev-parse --git-dir >/dev/null 2>&1 || fail "no engine checkout at $PHASE_DIR; clone $PHASE_REPO there or set YAMA_PHASE_DIR."
# Existing worktrees may still have an upstream origin. Fetch the configured source explicitly;
# a cached object alone does not prove that the dependency has been published.
# A pin is published when it is on main or on an archive/* tag: rebasing the fork's main keeps
# the previous line under such a tag, and a deployed engine stays releasable until Yama bumps it.
git -C "$PHASE_DIR" fetch --no-tags --prune "$PHASE_REPO" \
  '+refs/heads/main:refs/remotes/yama-phase/main' \
  '+refs/tags/archive/*:refs/remotes/yama-phase/archive/*' >&2 || fail "couldn't refresh the engine repository; cached refs are not sufficient."
git -C "$PHASE_DIR" cat-file -e "$PHASE_REV^{commit}" 2>/dev/null || fail "deploy/phase-rev ($PHASE_REV) isn't a commit in $PHASE_DIR."
published=
for ref in refs/remotes/yama-phase/main $(git -C "$PHASE_DIR" for-each-ref --format='%(refname)' refs/remotes/yama-phase/archive/); do
  if git -C "$PHASE_DIR" merge-base --is-ancestor "$PHASE_REV" "$ref"; then published=$ref; break; fi
done
[ -n "$published" ] || fail "deploy/phase-rev is not published on the engine repository's main or an archive/* tag."
echo "Phase check passed: $PHASE_REV is published in $PHASE_REPO." >&2
(cd "$PHASE_DIR" && pwd -P)
