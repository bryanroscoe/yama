#!/usr/bin/env bash
# Bring the primary checkout up to date with GitHub's main.
#
# Usage: scripts/sync-main.sh [CHECKOUT]
#   CHECKOUT  the checkout to update; default is the primary checkout (the one that owns .git).
#
# Run it after merging a PR. The primary checkout stays on origin/main and clean (AGENTS.md,
# "The primary checkout"), so agents who read it read current code:
#   on branch main  -> git merge --ff-only origin/main
#   detached        -> git switch --detach origin/main (main may be checked out in a worktree)
#   any other branch, or any tracked or untracked change (ignored files don't count) -> refuses
# It never stashes, resets, cleans or forces, and stops if GitHub can't be fetched: cached
# remote refs don't count as up to date.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

case "${1:-}" in
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
[ "$#" -le 1 ] || { echo 'sync-main: at most one path' >&2; exit 2; }

die() { echo "sync-main: $*" >&2; exit 1; }

if [ "$#" = 1 ]; then
  target="$1"
else
  # Any checkout of this repository, a linked worktree included, shares one common git dir; the
  # primary checkout is the directory that holds it.
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || die 'run it inside the repository, or pass the checkout path.'
  [ "$(basename "$common")" = .git ] || die "can't find the primary checkout from $common; pass its path."
  target="$(dirname "$common")"
fi
[ -d "$target" ] || die "no such directory: $target"
target="$(cd "$target" && pwd -P)"
git() { command git -C "$target" "$@"; }
[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$target" ] || die "$target is not the top of a git checkout."

# Half-finished work in the checkout is somebody's; leave it alone.
for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply sequencer; do
  if [ -e "$(git rev-parse --path-format=absolute --git-path "$state")" ]; then
    die "$target is in the middle of a merge, rebase, cherry-pick, revert or bisect ($state). Finish or abort it first."
  fi
done

dirty="$(git status --porcelain --untracked-files=all)"
if [ -n "$dirty" ]; then
  {
    echo "sync-main: $target has changes, so I did not touch it:"
    printf '%s\n' "$dirty" | sed 's/^/  /'
    echo 'The primary checkout should stay clean: do work in a worktree (AGENTS.md). Move or commit these'
    echo 'somewhere safe yourself; this script never stashes, resets or cleans.'
  } >&2
  exit 1
fi

git fetch --quiet origin main || die "couldn't fetch origin; a cached origin/main doesn't count as current. Try again when GitHub is reachable."
git rev-parse --verify --quiet refs/remotes/origin/main > /dev/null || die 'origin/main does not exist after fetching.'

old="$(git rev-parse HEAD)"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
case "$branch" in
  main)
    git merge-base --is-ancestor HEAD origin/main \
      || die "main in $target has commits origin/main lacks (it is ahead or has diverged). Keep that work on a branch (git branch NAME main), then reset main to origin/main yourself."
    # Ignored files are somebody's too: if origin/main now tracks a path one sits on, stop.
    git merge --ff-only --no-overwrite-ignore --quiet origin/main \
      || die "origin/main can't be fast-forwarded into $target: it would overwrite an ignored file. Move that file aside, then run this again."
    ;;
  '')
    git merge-base --is-ancestor HEAD origin/main \
      || die "$target is detached at $(git rev-parse --short HEAD), which origin/main does not contain. Switching would leave those commits only in the reflog: put them on a branch first."
    git switch --quiet --detach --no-overwrite-ignore origin/main \
      || die "origin/main can't be checked out in $target: it would overwrite an ignored file. Move that file aside, then run this again."
    ;;
  *)
    die "$target is on branch '$branch'. The primary checkout stays on main (or detached at origin/main); I won't move it off a branch. Finish or push that work from a worktree, then switch it back yourself."
    ;;
esac

new="$(git rev-parse HEAD)"
if [ "$old" = "$new" ]; then
  echo "sync-main: $target was already at origin/main ($(git rev-parse --short HEAD))."
else
  echo "sync-main: $target now at origin/main."
  git log --oneline --no-decorate -n 10 "$old..$new" | sed 's/^/  /' || true
  git diff --quiet "$old" "$new" -- package-lock.json \
    || echo 'sync-main: package-lock.json changed. Run npm ci in that checkout before running the web app or tests.'
fi

# Cargo builds against a sibling engine checkout pinned by deploy/phase-rev.
rev="$(tr -d '[:space:]' < "$target/deploy/phase-rev" 2>/dev/null || true)"
phase="$target/../yama-phase"
if [ -n "$rev" ]; then
  if [ ! -d "$phase" ]; then
    echo "sync-main: no engine checkout at $phase; Cargo builds need yama-phase at deploy/phase-rev ($rev)."
  else
    have="$(command git -C "$phase" rev-parse HEAD 2>/dev/null || true)"
    [ "$have" = "$rev" ] \
      || echo "sync-main: $phase is at ${have:-an unknown commit}, not deploy/phase-rev ($rev). Cargo builds and local-ci want the pinned engine; check it out there (that checkout is shared: tell the lead first)."
  fi
fi
