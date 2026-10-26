#!/usr/bin/env python3
"""Rebuild the real-deck card corpus and compare explicit parser gaps.

Names go to --out for sweep.py. Optional --card-data and --compare exports
produce a parser-only report; these counts say nothing about runtime correctness.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re


def corpus(root):
    counts = Counter()
    files = sorted(root.glob("precons/*.txt")) + sorted(root.glob("bryan/*.txt"))
    if not files:
        raise ValueError(f"no deck files under {root}")
    for path in files:
        names = set()
        for line in path.read_text().splitlines():
            match = re.fullmatch(r"\s*\d+\s+(.+?)\s*", line)
            if match:
                names.add(match[1])
        counts.update(names)
    basics = {"Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"}
    names = sorted((n for n in counts if n not in basics and not n.startswith("Snow-Covered")),
                   key=lambda n: (-counts[n], n))
    return names, len(files)


def unimplemented(value):
    if isinstance(value, dict):
        return value.get("type") == "Unimplemented" or any(unimplemented(v) for v in value.values())
    if isinstance(value, list):
        return any(unimplemented(v) for v in value)
    return False


def gaps(path, names):
    data = json.loads(path.read_text())
    missing, partial, warnings = [], [], []
    for name in names:
        face = data.get(name.lower()) or data.get(name.split(" // ")[0].lower())
        if face is None:
            missing.append(name)
        else:
            if unimplemented(face):
                partial.append(name)
            if face.get("parse_warnings"):
                warnings.append(name)
    return {"missing": missing, "unimplemented": partial, "warnings": warnings}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--decks-root", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--card-data", type=Path)
    ap.add_argument("--compare", type=Path, help="previous card export")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()
    if args.compare and not args.card_data:
        ap.error("--compare requires --card-data")
    names, decks = corpus(args.decks_root)
    args.out.write_text(json.dumps(names, ensure_ascii=False, indent=2) + "\n")
    report = {"decks": decks, "cards": len(names)}
    if args.card_data:
        after = gaps(args.card_data, names)
        report["after"] = after
        if args.compare:
            before = gaps(args.compare, names)
            report["before"] = before
            for key in before:
                report[key + "_cleared"] = sorted(set(before[key]) - set(after[key]))
                report[key + "_added"] = sorted(set(after[key]) - set(before[key]))
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"decks": decks, "cards": len(names),
                      **({"gaps": len(report["after"]["unimplemented"])} if args.card_data else {})}))


if __name__ == "__main__":
    main()
