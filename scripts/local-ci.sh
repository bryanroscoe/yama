#!/usr/bin/env bash
# Run the checks GitHub CI runs, then record them on HEAD so PR CI can skip.
#
# Requires a clean worktree, Rust 1.98.1, and ../yama-phase at the published
# commit in deploy/phase-rev.
# On success it amends HEAD's message (not its content) with
#   Local-CI: passed tree=<HEAD^{tree}> on <os>/<arch> node<major>
# The CI gate skips the web and Rust jobs for a PR whose head commit carries
# that trailer for its own tree and already contains main. Any later commit
# without its own trailer runs CI again. Push CI on main always runs in full.
#
# Usage: scripts/local-ci.sh [--no-amend]
#   --no-amend  run the checks only; leave HEAD unchanged.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

amend=1
[ "$#" -le 1 ] || { echo 'local-ci: at most one option' >&2; exit 2; }
case "${1:-}" in
  '') ;;
  --no-amend) amend=0 ;;
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "local-ci: unknown option $1" >&2; exit 2 ;;
esac

die() { echo "local-ci: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

root="$(git rev-parse --show-toplevel)"
cd "$root"

# The trailer vouches for HEAD's tree, so nothing else may be in the worktree.
[ -z "$(git status --porcelain --untracked-files=all)" ] \
  || die 'commit or remove local changes first; the checks must run on exactly HEAD.'
head="$(git rev-parse HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"

# Cargo builds against the sibling engine checkout; it must be CI's pinned engine.
phase_rev="$(cat deploy/phase-rev)"
phase_dir="$root/../yama-phase"
[ -d "$phase_dir" ] || die "no engine checkout at $phase_dir; check out bryanroscoe/yama-phase there at $phase_rev."
[ "$(git -C "$phase_dir" rev-parse HEAD)" = "$phase_rev" ] \
  || die "$phase_dir is not at deploy/phase-rev ($phase_rev); CI tests that engine."
[ -z "$(git -C "$phase_dir" status --porcelain --untracked-files=all)" ] \
  || die "$phase_dir has local changes or untracked files; CI tests the published engine."
# A pin only on this machine would pass here and then break push CI on main.
YAMA_PHASE_DIR="$phase_dir" deploy/check-phase.sh >/dev/null \
  || die 'the engine pin must be published first (see deploy/check-phase.sh above).'

# Local checks only stand in for CI when the branch already contains main.
if git fetch --quiet origin main 2>/dev/null; then
  git merge-base --is-ancestor FETCH_HEAD HEAD \
    || echo 'local-ci: warning: HEAD does not contain origin/main; PR CI will still run until you rebase or merge and run this again.' >&2
else
  echo 'local-ci: warning: could not fetch origin/main; PR CI runs if the branch is behind main.' >&2
fi

# CI pins Rust 1.98.1 and Node 22. A different Node major only warns (and is recorded),
# since the web checks rarely depend on it; push CI on main still runs Node 22.
rust_version="$(rustc --version)"
case "$rust_version" in
  'rustc 1.98.1 '*) ;;
  *) die "CI uses Rust 1.98.1, not '$rust_version'; try RUSTUP_TOOLCHAIN=1.98.1." ;;
esac
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" = 22 ] || echo "local-ci: warning: CI uses Node 22; this is Node $node_major." >&2

step 'Web checks'
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run build

step 'Rust tests'
cargo test --locked

step 'Python tests'
python3 deploy/test_release.py
python3 deploy/test_host.py
python3 -m unittest discover -s tools -p 'test_lab*.py'
python3 forge-worker/test_worker.py
python3 -m unittest discover -s scripts/research -p 'test_*.py'
python3 -m unittest discover -s scripts/datasets -p 'test_*.py'
python3 -O -m unittest discover -s scripts/research -p 'test_*.py'
python3 -m unittest discover -s scripts/ci -p 'test_*.py'

# The checks must not have changed tracked files or HEAD.
[ "$(git rev-parse HEAD)" = "$head" ] || die 'HEAD moved while the checks ran; run again.'
[ -z "$(git status --porcelain --untracked-files=no)" ] || die 'the checks changed tracked files; commit them and run again.'

trailer="Local-CI: passed tree=$tree on $(uname -s)/$(uname -m) node$node_major"
if [ "$amend" = 0 ]; then
  printf '\nAll checks passed on tree %s. HEAD left unchanged (--no-amend).\n' "$tree"
  exit 0
fi
git -c trailer.ifexists=replace commit --quiet --amend --no-edit --no-verify --trailer "$trailer"
[ "$(git rev-parse 'HEAD^{tree}')" = "$tree" ] || die 'amending changed the tree; check HEAD.'
printf '\nAll checks passed. HEAD now records:\n  %s\n' "$trailer"
echo 'Push it (use --force-with-lease if this commit was already pushed); PR CI will skip its web and Rust jobs.'
