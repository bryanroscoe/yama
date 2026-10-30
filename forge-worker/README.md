# Forge worker

Forge as a second engine for Yama's Lab runs (server/src/lab/forge.rs, deploy/Dockerfile.forge-worker).

- `worker.py`: Yama's HTTP front, called by the yama server only (private network, `x-forge-secret`).
- `forge_runner.py`, `common.py`: copies of commander-decks `scripts/sim/forge_runner.py` and `common.py`
  (commit 689dbc5). Keep them identical to those files; the worker only overrides where they write
  (`DECK_CACHE`, `WORK_ROOT`, the card index folder) and the seed it passes Forge.
- Forge itself is Yama's own build, not a release: `deploy/Dockerfile.forge-worker` unpacks a pinned tarball
  (forge-referee `dist/build-dist.sh`; current build `yama2`, Forge master 3ead7e68 with AI speed fixes, see
  forge-referee `patches/yama2/README.md`). Results carry its label, `forge 2.0.16-745401a4+yama2`.
- `test_worker.py`: `python3 forge-worker/test_worker.py` (no Forge needed).

Forge (https://github.com/Card-Forge/forge) is GPL-3.0 and runs as a separate program, one JVM per game. None of
its code is here. Private use.

Locally: `FORGE_SECRET=<32+ chars> FORGE_DIR=~/Developer/forge-engine/forge-2.0.15
FORGE_JAVA=/opt/homebrew/opt/openjdk@17/bin/java FORGE_WORK=/tmp/fw FORGE_INDEX=/tmp/fw-index python3
forge-worker/worker.py`, then start Yama with `YAMA_FORGE_URL=http://127.0.0.1:8791` and the same secret.
