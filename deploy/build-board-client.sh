#!/usr/bin/env bash
# Bundle an exported Phase client after its WASM bindings and dependencies exist.
# Both the isolated local builder and the production image use this boundary.
set -euo pipefail
phase=$(cd "${1:?Phase source}" && pwd -P)
out=${2:?bundle output}
revision=${3:?full Phase revision}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid Phase revision' >&2; exit 1; }
public=$(mktemp -d "${TMPDIR:-/tmp}/yama-board-public.XXXXXX")
trap 'rm -rf "$public"' EXIT
cp -R "$phase/client/public/." "$public/"
rm -rf "$public/card-animation-previews"
mkdir -p "$public/licenses"
cp "$phase/LICENSE-MIT" "$phase/LICENSE-APACHE" "$phase/NOTICE" "$public/licenses/"
for family in newsreader jetbrains-mono; do
  mkdir -p "$public/licenses/$family"
  cp "$phase/client/node_modules/@fontsource-variable/$family/LICENSE" "$public/licenses/$family/"
done
cd "$phase/client"
run_pnpm() {
  if command -v pnpm >/dev/null; then command pnpm "$@"; else npx -y "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')" "$@"; fi
}
PHASE_BUILD_REVISION="$revision" \
PHASE_BASE_PATH=/board/ \
PHASE_PUBLIC_DIR="$public" \
VITE_TEXT_ICONS=1 \
VITE_HOSTED_CARD_ART=1 \
DATA_BASE_URL=/api/play/board-data \
CARD_DATA_URL=/api/play/board-data/card-data.json \
  run_pnpm exec vite build --outDir "$out" --emptyOutDir
printf '{"phase_revision":"%s"}\n' "$revision" > "$out/yama-board.json"
