# Forge worker

Forge as a second engine for Yama's Lab runs (server/src/lab/forge.rs, deploy/Dockerfile.forge-worker).

- `worker.py`: Yama's HTTP front, called by the yama server only (private network, `x-forge-secret`).
- `forge_runner.py`, `common.py`: copies of commander-decks `scripts/sim/forge_runner.py` and `common.py`
  (commit 689dbc5). Keep them identical to those files; the worker only overrides where they write
  (`DECK_CACHE`, `WORK_ROOT`, the card index folder) and the seed it passes Forge.
- `patch_jar.py`: overlays Yama's Forge patch set (compiled classes, kept in the private forge-referee repo because
  they are Forge code) on the release jar at image build, checks its SHA-256 pin and renames the jar, so results carry
  `forge 2.0.15+<name>`. Current set `yama1` (forge-referee `patches/yama1/README.md`): skip the full static-ability
  recompute for spells no stack-zone static affects; choose the preferred opponent (a combat simulation) only for a
  targeted curse.
- `test_worker.py`: `python3 forge-worker/test_worker.py` (no Forge needed).

Forge (https://github.com/Card-Forge/forge) is GPL-3.0 and runs as a separate program, one JVM per game. None of
its code is here. Private use.

Locally: `FORGE_SECRET=<32+ chars> FORGE_DIR=~/Developer/forge-engine/forge-2.0.15
FORGE_JAVA=/opt/homebrew/opt/openjdk@17/bin/java FORGE_WORK=/tmp/fw FORGE_INDEX=/tmp/fw-index python3
forge-worker/worker.py`, then start Yama with `YAMA_FORGE_URL=http://127.0.0.1:8791` and the same secret.
