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
# Cargo builds into one shared target directory outside the worktree
# ($YAMA_CARGO_TARGET_DIR, default ~/Library/Caches/yama/cargo-target), so the
# Phase engine, the slowest and largest compile, is built once for every
# worktree instead of once each. A CARGO_TARGET_DIR you set yourself wins.
# Only the areas (web, Rust, Python) that what the branch changes since main needs
# are checked, by CI's own rule (scripts/ci/gate.py areas_needed), as PR CI skips
# the others; --full runs every check anyway.
#
# Usage: scripts/local-ci.sh [--no-amend] [--full]
#   --no-amend  run the checks only; leave HEAD unchanged.
#   --full      run every check, whatever changed.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

amend=1
full=0
for option in "$@"; do
  case "$option" in
    --no-amend) amend=0 ;;
    --full) full=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "local-ci: unknown option $option" >&2; exit 2 ;;
  esac
done

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
# Unknown changes (no fetch, no merge base, nothing changed) mean the full run.
web=1 rust=1 python=1
if git fetch --quiet origin main 2>/dev/null; then
  git merge-base --is-ancestor FETCH_HEAD HEAD \
    || echo 'local-ci: warning: HEAD does not contain origin/main; PR CI will still run until you rebase or merge and run this again.' >&2
  if [ "$full" = 0 ] && base="$(git merge-base FETCH_HEAD HEAD 2>/dev/null)"; then
    # Skip only on a positive answer: a failed diff or a failing or missing interpreter
    # means the full run.
    changed="$(mktemp)"
    if git diff --no-renames --name-only -z "$base" HEAD > "$changed"; then
      verdict="$(python3 -I -B -c '
import sys
sys.path.insert(0, sys.argv[1])
from gate import areas_needed, cross_reads, tracked_files
files = [f for f in sys.stdin.buffer.read().decode().split("\0") if f]
# Paths the branch deleted or renamed away still count: code naming one needs its area.
gone = sorted(set(files) - set(tracked_files()))
print("needs:" + ",".join(sorted(areas_needed(files, cross_reads(gone=gone)))))' "$root/scripts/ci" < "$changed" 2>/dev/null || true)"
      case "$verdict" in
        needs:*)
          needs=",${verdict#needs:},"
          [[ "$needs" == *,web,* ]] || web=0
          [[ "$needs" == *,rust,* ]] || rust=0
          [[ "$needs" == *,python,* ]] || python=0
          ;;
      esac
    fi
    rm -f "$changed"
  fi
else
  echo 'local-ci: warning: could not fetch origin/main; PR CI runs if the branch is behind main.' >&2
fi

# One Cargo target directory for every worktree: the engine builds once.
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  export CARGO_TARGET_DIR="${YAMA_CARGO_TARGET_DIR:-$HOME/Library/Caches/yama/cargo-target}"
fi
mkdir -p "$CARGO_TARGET_DIR"

# CI pins Rust 1.98.1 and Node 22. A different Node major only warns (and is recorded),
# since the web checks rarely depend on it; push CI on main still runs Node 22.
rust_version="$(rustc --version)"
case "$rust_version" in
  'rustc 1.98.1 '*) ;;
  *) die "CI uses Rust 1.98.1, not '$rust_version'; try RUSTUP_TOOLCHAIN=1.98.1." ;;
esac
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" = 22 ] || echo "local-ci: warning: CI uses Node 22; this is Node $node_major." >&2

skipped() { step "$1: skipped, nothing changed since main needs them (--full runs them)"; }

if [ "$web" = 0 ]; then
  skipped 'Web checks'
else
  step 'Web checks'
  npm ci --no-audit --no-fund
  npm test
  npm run typecheck
  npm run build
fi

if [ "$rust" = 0 ]; then
  skipped 'Rust tests'
else
  step 'Rust tests'
  echo "Cargo target: $CARGO_TARGET_DIR"
  # Cargo names the workspace's own crates by their path inside the worktree, so every
  # worktree's yama-server and yama-play land on the same artifacts here, judged fresh by
  # file times. Rebuild them from this worktree on every run (the engine and crates.io
  # dependencies stay cached), and hold a lock so no other run swaps them in between.
  # perl holds the lock and runs Cargo as its child, so the lock lasts the whole step.
  perl -MFcntl=:flock -e '
    open(my $lock, ">>", shift) or die "local-ci: cannot open the Cargo target lock: $!\n";
    unless (flock($lock, LOCK_EX | LOCK_NB)) {
      print STDERR "local-ci: waiting for another local-ci run using this Cargo target\n";
      flock($lock, LOCK_EX) or die "local-ci: cannot lock the Cargo target: $!\n";
    }
    my $status = system(@ARGV);
    exit($status == -1 ? 127 : ($status & 127) ? 128 + ($status & 127) : $status >> 8);
  ' "$CARGO_TARGET_DIR/.yama-local-ci.lock" \
    bash -c 'cargo clean --quiet -p yama-server -p yama-play && cargo test --locked'
fi

if [ "$python" = 0 ]; then
  skipped 'Python tests'
else
  step 'Python tests'
  python3 deploy/test_release.py
  python3 deploy/test_host.py
  python3 runtime/test_source_availability.py
  python3 runtime/test_provenance.py
  python3 -m unittest discover -s tools -p 'test_lab*.py'
  python3 forge-worker/test_worker.py
  python3 -m unittest discover -s scripts/research -p 'test_*.py'
  python3 -m unittest discover -s scripts/datasets -p 'test_*.py'
  python3 -O -m unittest discover -s scripts/research -p 'test_*.py'
  python3 -m unittest discover -s scripts/ci -p 'test_*.py'
  python3 -m unittest discover -s scripts/history -p 'test_*.py'
  python3 scripts/test_sync_main.py
  python3 scripts/test_dev_local.py
  python3 scripts/test_package_yama_plugin.py
fi

# The checks must not have changed tracked files or HEAD.
[ "$(git rev-parse HEAD)" = "$head" ] || die 'HEAD moved while the checks ran; run again.'
[ -z "$(git status --porcelain --untracked-files=all)" ] \
  || die 'the checks changed tracked files or left untracked ones; commit or remove them and run again.'
[ -z "$(git -C "$phase_dir" status --porcelain --untracked-files=all)" ] \
  || die "the checks changed $phase_dir; CI tests the published engine."

trailer="Local-CI: passed tree=$tree on $(uname -s)/$(uname -m) node$node_major"
if [ "$amend" = 0 ]; then
  printf '\nAll checks passed on tree %s. HEAD left unchanged (--no-amend).\n' "$tree"
  exit 0
fi
git -c trailer.ifexists=replace commit --quiet --amend --no-edit --no-verify --trailer "$trailer"
[ "$(git rev-parse 'HEAD^{tree}')" = "$tree" ] || die 'amending changed the tree; check HEAD.'
printf '\nAll checks passed. HEAD now records:\n  %s\n' "$trailer"
echo 'Push it (use --force-with-lease if this commit was already pushed); PR CI will skip its web and Rust jobs.'
