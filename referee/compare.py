#!/usr/bin/env python3
"""Compare the Forge and phase runs of the referee scenarios.

    python3 referee/compare.py FORGE.json PHASE.json [--json REPORT.json]

Each input is a list of final states (one per scenario) in the shared shape. Prints, per scenario,
whether the two engines agree, and where they don't. Exit status 1 when any scenario differs or
errored, so this can run as a test.
"""
import json
import sys

IGNORED = {"engine", "scenario", "ms", "log", "about"}


def diff(a, b, path=""):
    """Differences between two final states, as (path, forge value, phase value)."""
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k in IGNORED:
                continue
            out += diff(a.get(k), b.get(k), f"{path}.{k}" if path else k)
    elif isinstance(a, list) and isinstance(b, list) and path.endswith("battlefield"):
        # Permanents compare as a multiset: each side's leftovers are the difference.
        left = [json.dumps(x, sort_keys=True) for x in a]
        right = [json.dumps(x, sort_keys=True) for x in b]
        for x in list(left):
            if x in right:
                left.remove(x)
                right.remove(x)
        for x in left:
            out.append((path, json.loads(x), None))
        for x in right:
            out.append((path, None, json.loads(x)))
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and any(isinstance(x, dict) for x in a):
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f"{path}.{i}")
    elif a != b:
        out.append((path, a, b))
    return out


def main():
    args = sys.argv[1:]
    report_path = None
    if "--json" in args:
        i = args.index("--json")
        report_path = args[i + 1]
        del args[i:i + 2]
    forge = {r["scenario"]: r for r in json.load(open(args[0]))}
    phase = {r["scenario"]: r for r in json.load(open(args[1]))}
    report = []
    bad = 0
    for name in sorted(set(forge) | set(phase)):
        f, p = forge.get(name), phase.get(name)
        entry = {"scenario": name}
        if f is None or p is None:
            entry["verdict"] = "missing"
            entry["missing"] = "forge" if f is None else "phase"
        elif f.get("error") or p.get("error"):
            entry["verdict"] = "error"
            entry["forge_error"] = f.get("error")
            entry["phase_error"] = p.get("error")
        else:
            d = diff({k: v for k, v in f.items() if k != "error"}, {k: v for k, v in p.items() if k != "error"})
            entry["verdict"] = "agree" if not d else "differ"
            entry["differences"] = [{"path": x, "forge": y, "phase": z} for x, y, z in d]
        if f is not None and p is not None:
            entry["ms"] = {"forge": f.get("ms"), "phase": p.get("ms")}
            entry["log"] = {"forge": f.get("log", []), "phase": p.get("log", [])}
        report.append(entry)
        if entry["verdict"] != "agree":
            bad += 1

        ms = entry.get("ms", {})
        print(f"{entry['verdict']:7} {name}  (forge {ms.get('forge')} ms, phase {ms.get('phase')} ms)")
        if entry["verdict"] == "error":
            for side in ("forge", "phase"):
                if entry.get(f"{side}_error"):
                    print(f"        {side}: {entry[side + '_error']}")
        for x in entry.get("differences", []):
            print(f"        {x['path']}: forge {json.dumps(x['forge'])}  phase {json.dumps(x['phase'])}")

    print(f"\n{len(report) - bad} of {len(report)} agree")
    if report_path:
        with open(report_path, "w") as fh:
            json.dump(report, fh, indent=2)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
