# Forge worker

Forge as a second engine for Yama's Lab runs (server/src/lab/forge.rs, deploy/Dockerfile.forge-worker).

- `worker.py`: Yama's HTTP front, called by the yama server only (private network, `x-forge-secret`).
- `forge_serve.py`: one long-lived Forge JVM per slot, playing its games one after another (the build's
  `yama-serve.jar`, from forge-referee `serve/`). The card database loads once and the JIT stays warm: about half
  the CPU per game, the same games (8 of 9 pilot games identical to one JVM per game; the ninth also varies between
  two fresh JVMs). A JVM is replaced after a game at Forge's time limit, a crash or a kill, and every 200 games.
  `FORGE_SERVE=0`, or a Forge build without the jar, plays one JVM per game as before.
- `forge_runner.py`, `common.py`: copies of commander-decks `scripts/sim/forge_runner.py` and `common.py`
  (commit 689dbc5). Keep them identical to those files; the worker only overrides where they write
  (`DECK_CACHE`, `WORK_ROOT`, the card index folder) and the seed it passes Forge.
- Forge is the 2.0.16 release plus the five retained Yama optimizations and the
  reviewed shared-team poison-defense integration fix, source `559a7be0`.
  `forge-referee/dist/build-dist.sh` builds `yama4` and recompiles `yama-serve.jar`
  against that engine. The pinned package is SHA-256
  `c77b32ebedaf37d890560c0f13fd9a54887ab2954d8e3681cd3cb46a2beccfab`;
  results carry `forge 2.0.16-559a7be0+yama4.c77b32eb`.
- `test_worker.py`: `python3 forge-worker/test_worker.py` (no Forge needed).

Forge (https://github.com/Card-Forge/forge) is GPL-3.0 and runs as separate programs (its own JVMs). None of
its code is here. Private use.

Locally: `FORGE_SECRET=<32+ chars> FORGE_DIR=<a Forge folder, e.g. one unpacked from forge-dist-yama3.tar.gz>
FORGE_JAVA=/opt/homebrew/opt/openjdk@17/bin/java FORGE_WORK=/tmp/fw FORGE_INDEX=/tmp/fw-index python3
forge-worker/worker.py`, then start Yama with `YAMA_FORGE_URL=http://127.0.0.1:8791` and the same secret.
