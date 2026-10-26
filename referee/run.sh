#!/bin/sh
# referee/run.sh [SCENARIO.json...]   (default: every scenario)
# Plays each scenario in Forge and in phase and compares the final states.
# Needs the Forge referee (FORGE_REFEREE, default ~/Developer/forge-referee, kept outside this
# repo) and a release build of the phase runner (cargo build --release -p yama-play --bin referee).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
FORGE_REFEREE=${FORGE_REFEREE:-$HOME/Developer/forge-referee}
# The card data must match the engine build: default to the file the deploy pins.
CARD_DATA=${YAMA_ENGINE_CARD_DATA:-$ROOT/data/engine/$(sed -n 's/^CARD_DATA=//p' "$ROOT/deploy/first-time.sh")}
OUT=${REFEREE_OUT:-/tmp/yama-referee}
mkdir -p "$OUT"
[ $# -gt 0 ] || set -- "$HERE"/scenarios/*.json
"$FORGE_REFEREE/run.sh" "$OUT/forge.json" "$@"
"$ROOT/target/release/referee" --card-data "$CARD_DATA" --out "$OUT/phase.json" "$@" 2> "$OUT/phase.log"
python3 "$HERE/compare.py" "$OUT/forge.json" "$OUT/phase.json" --json "$OUT/report.json"
