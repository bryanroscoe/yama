#!/usr/bin/env bash
# Build phase's web client as Yama's board, served at /board/ (YAMA_BOARD_DIST; ARCHITECTURE.md,
# "phase's own board"). The client comes from a yama-phase checkout at the commit Yama pins
# (deploy/phase-rev), so its protocol matches the engine the server runs.
#
#   deploy/build-board.sh ../yama-phase web/board-dist
#
# Needs Python 3, pnpm (or npx), and for the engine WASM the wasm32-unknown-unknown target and the
# wasm-bindgen CLI at the version in the checkout's Cargo.lock.
#
# Audio and battlefield backgrounds are included (Bryan, 2026-10-30). Preview videos contain
# card art and stay out. Mana images load from Scryfall; other icons use text fallbacks.
# Build an isolated checkout of the pin, including its own bindings and dependencies.
# CARGO_TARGET_DIR may name a reusable cache outside the supplied source checkout.
set -euo pipefail

phase=${1:?usage: deploy/build-board.sh <yama-phase checkout> <output dir>}
out=${2:?usage: deploy/build-board.sh <yama-phase checkout> <output dir>}
phase=$(cd "$phase" && pwd -P)
repo=$(cd "$(dirname "$0")/.." && pwd)
expected=$(tr -d '\r\n' < "$repo/deploy/phase-rev")
if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]] || ! git -C "$phase" cat-file -e "$expected^{commit}" 2>/dev/null; then
  echo "Phase checkout does not contain pinned revision $expected" >&2
  exit 1
fi
out=$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$out")
python3 "$repo/deploy/board_output.py" check "$out" "$repo" "$phase"
if [ -n "${CARGO_TARGET_DIR:-}" ]; then
  CARGO_TARGET_DIR=$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$CARGO_TARGET_DIR")
  case "$CARGO_TARGET_DIR" in "$phase"|"$phase"/*) echo "Cargo cache must be outside the supplied Phase checkout" >&2; exit 1 ;; esac
fi
# dirname preserves / for a destination directly below the filesystem root.
out_parent=$(dirname "$out")
mkdir -p "$out_parent"

run_pnpm() {
  if command -v pnpm >/dev/null; then command pnpm "$@"; else npx -y "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')" "$@"; fi
}

stage=$(mktemp -d "${out_parent%/}/.board-build.XXXXXX")
cleanup() {
  local status=$?
  trap - EXIT
  cd "$repo"
  if [ -d "$stage/target" ]; then
    # Respect the Mac's supported artifact cleanup and any refusal. Other build
    # hosts use Cargo's clean command for this newly created disposable target.
    if command -v agent-clean >/dev/null; then
      if ! agent-clean "$stage/source" --target-dir "$stage/target" --all \
        || ! agent-clean "$stage/source" --target-dir "$stage/target" --all --apply \
          --reason "Yama board packaging; owned disposable compilation; final bundle retained"; then
        echo "Board build scratch retained after cleanup refusal: $stage" >&2
        exit 1
      fi
    elif ! cargo clean --frozen --manifest-path "$stage/source/Cargo.toml" --target-dir "$stage/target"; then
      echo "Board build scratch retained after Cargo cleanup failed: $stage" >&2
      exit 1
    fi
  fi
  if [ -e "$stage/previous-output" ]; then
    echo "Board output publication incomplete; scratch retained: $stage" >&2
    exit 1
  fi
  rm -rf "$stage"
  exit "$status"
}
trap cleanup EXIT
# Shared Git objects are read-only here. Generated files, index and dependency
# installs belong to this clone; no worktree registration or source edit occurs.
git -c core.hooksPath=/dev/null clone --shared --no-checkout -- "$phase" "$stage/source"
git -C "$stage/source" -c core.hooksPath=/dev/null checkout --detach "$expected"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$stage/target}"
(cd "$stage/source" && CARGO_BUILD_JOBS=1 ./scripts/build-wasm.sh)
cd "$stage/source/client"
run_pnpm install --frozen-lockfile
bash "$repo/deploy/build-board-client.sh" "$stage/source" "$stage/bundle" "$expected"
python3 "$repo/deploy/board_output.py" publish "$stage/bundle" "$out" "$repo" "$phase"
echo "phase's board: $out"
