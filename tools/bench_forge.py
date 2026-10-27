#!/usr/bin/env python3
"""Offline, sequential JVM experiments using saved /play request JSON; never submits results.

Outputs include private deck IDs/results. Store them in ignored data/, not in the repository.
Run with --help. Each trial gets a fresh JVM, as in production. No Forge code is imported.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "forge-worker"))
import worker as W

VARIANTS = {"default": "", "serial": "-XX:+UseSerialGC",
            "parallel": "-XX:+UseParallelGC", "c1": "-XX:TieredStopAtLevel=1"}


def equivalent(left, right):
    """Only completed games with identical observable results qualify as matched work."""
    if left.get("end") not in ("win", "draw") or right.get("end") not in ("win", "draw"):
        return False
    return ({k: v for k, v in left.items() if k not in ("ms", "runner")}
            == {k: v for k, v in right.items() if k not in ("ms", "runner")})


def runtime_identity(forge):
    def digest(path):
        with path.open("rb") as source:
            return hashlib.file_digest(source, "sha256").hexdigest()

    version = subprocess.run([forge.java, "-version"], capture_output=True, text=True, check=True, timeout=15)
    return {"java_version": version.stdout + version.stderr,
            "forge_jar_sha256": digest(forge.jar),
            "forge_cards_sha256": digest(forge.res / "cardsfolder/cardsfolder.zip")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("requests", nargs="+", type=Path)
    parser.add_argument("--forge", required=True, type=Path)
    parser.add_argument("--java", default="java")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--variants", nargs="+", choices=VARIANTS, default=["default", "serial", "parallel", "c1"])
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--xmx", default="1536m")
    parser.add_argument("--jvm-cpus", type=int, default=2)
    args = parser.parse_args()
    # SIGTERM should unwind the same cleanup path as Ctrl-C, including the JVM process group.
    def terminated(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminated)
    if args.repeats < 1 or args.jvm_cpus < 1:
        parser.error("repeats and jvm-cpus must be positive")
    # Hidden inherited Java options would make the named configurations misleading.
    for key in ("JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"):
        if os.environ.get(key):
            parser.error(f"unset {key} before benchmarking")
    requests = [(p, p.read_bytes()) for p in args.requests]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Fail rather than silently mixing new trials into old evidence.
    with args.out.open("x", encoding="utf-8") as output, tempfile.TemporaryDirectory(prefix="yama-forge-bench-") as scratch:
        root = Path(scratch)
        W.F.CACHE, W.F.DECK_CACHE, W.F.WORK_ROOT = root / "cache", root / "decks", root / "work"
        forge = W.F.Forge(str(args.forge.resolve()), args.java)
        identity = runtime_identity(forge)
        worker = W.Worker(forge, W.F.card_index(forge), slots=1, xmx=args.xmx, jvm_cpus=args.jvm_cpus)
        original = W.F.Runner.play
        original_popen = W.F.subprocess.Popen
        baseline = {}
        for repeat in range(args.repeats):
            # Reverse each block to reduce systematic warm-cache/order bias.
            variants = args.variants if repeat % 2 == 0 else list(reversed(args.variants))
            for path, raw in requests:
                digest = hashlib.sha256(raw).hexdigest()
                for variant in variants:
                    request = json.loads(raw)
                    request["key"] = f"bench-{digest[:16]}-{repeat}-{variant}"
                    stats = []
                    children = []

                    def launch(*values, **options):
                        child = original_popen(*values, **options)
                        children.append(child)
                        return child

                    def measured(runner, job):
                        result, metrics = original(runner, job)
                        stats.append(metrics)
                        return result, metrics

                    started = time.monotonic()
                    with (patch.dict(os.environ, {"JAVA_TOOL_OPTIONS": VARIANTS[variant]}),
                          patch.object(W.F.Runner, "play", measured),
                          patch.object(W.F.subprocess, "Popen", launch)):
                        try:
                            result = worker._play(request)
                        finally:
                            # Ctrl-C or a wrapper exception must not leave a JVM consuming a core.
                            for child in children:
                                if child.returncode is None:
                                    W.F.kill_group(child)
                                    child.wait()
                    if variant == "default":
                        baseline.setdefault(digest, result)
                    row = {"request_sha256": digest, "request_file": path.name, "repeat": repeat,
                           "variant": variant, "java_options": VARIANTS[variant], "java": args.java,
                           "runtime": identity,
                           "host": platform.platform(), "xmx": args.xmx, "jvm_cpus": args.jvm_cpus,
                           "total_wall_s": time.monotonic() - started, "result": result, "stats": stats,
                           "matches_first_baseline": equivalent(baseline[digest], result) if digest in baseline else None}
                    output.write(json.dumps(row) + "\n")
                    output.flush()
                    print(f"{path.name} {repeat} {variant}: {result['end']}, {row['total_wall_s']:.2f}s, matched={row['matches_first_baseline']}", flush=True)


if __name__ == "__main__":
    main()
