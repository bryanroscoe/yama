#!/usr/bin/env python3
"""Turn the Mythic Tools clean-room hand-off into a yama-dataset/1 file for the commander ranking.

    python3 -I scripts/mythic-commander-dataset.py DELIVER_DIR OUT.json

DELIVER_DIR is the clean room's deliver/ directory: commander_scores.csv and
analysis_summary.json, derived rates and scores (ARCHITECTURE.md, "Public commander ranking"). Mythic's
responses never pass through here and the output never goes into git. Import it as a private
dataset, then let it feed /commanders:

    yama-server import-dataset OUT.json --owner EMAIL
    yama-server commander-evidence use "Mythic Tools" --owner EMAIL
"""
import csv
import hashlib
import json
import sys
from pathlib import Path


def main(deliver: Path, out: Path) -> None:
    scores = deliver / "commander_scores.csv"
    summary_file = deliver / "analysis_summary.json"
    summary = json.loads(summary_file.read_text())
    baseline = float(summary["baseline"])
    prior = float(summary["prior"])
    if not (0 < baseline < 1 and prior > 0):
        sys.exit("analysis_summary.json has no usable baseline and prior")
    digest = hashlib.sha256(scores.read_bytes()).hexdigest()
    # The baseline and prior come from the summary, so a revision names both files it used.
    summary_digest = hashlib.sha256(summary_file.read_bytes()).hexdigest()
    records = []
    with scores.open(newline="") as f:
        for row in csv.DictReader(f):
            ids = sorted(s.strip() for s in row["oracle_id"].split("+"))
            if not ids or any(len(i) != 36 for i in ids):
                sys.exit(f"unexpected oracle id: {row['oracle_id']!r}")
            key = ".".join(ids)
            score, lo, hi = (float(row[k]) for k in ("score_0_100", "interval_low", "interval_high"))
            if not (0 < lo <= score <= hi < 100):
                sys.exit(f"score out of range for {row['commander']}")
            rate = float(row["win_rate"]) if row.get("win_rate", "").strip() else None
            if rate is not None and not 0 <= rate <= 1:
                sys.exit(f"win rate out of range for {row['commander']}")
            if rate is not None and int(row["games"]) <= 0:
                sys.exit(f"observed win rate requires reported games for {row['commander']}")
            records.append({
                "id": f"mythic:commander:{key}",
                "kind": "commander",
                "entity": f"mythic:commander:{key}",
                "sources": [digest, summary_digest],
                "data": {
                    **({"win_rate": rate} if rate is not None else {}),
                    "name": row["commander"],
                    "oracle_ids": ids,
                    "score_0_100": score,
                    "interval_low": lo,
                    "interval_high": hi,
                    "games": int(row["games"]),
                    "decks": int(row["decks"]),
                    "confidence": row["confidence"],
                    "baseline": baseline,
                    "prior_strength": prior,
                    "notes": row["notes"],
                },
            })
    coverage = {k: summary["coverage"][k] for k in ("commanders", "successful", "partner_precons") if k in summary.get("coverage", {})}
    # The first hand-off (2026-10-31) predates these keys; later ones name their own collection window.
    finished = summary.get("snapshot_finished_at", "2026-10-31T14:38:25Z")
    if "snapshot_started_at" not in summary:
        cohort = "Commanders that face catalog precons only."
    elif summary.get("complete"):
        cohort = "Every commander-legal card, looked up one by one, plus the catalog precons' faces."
    else:
        cohort = f"A partial lookup of every commander-legal card: {len(records)} so far."
    doc = {
        "schema": "yama-dataset/1",
        "id": "mythic-commander-scores",
        "title": "Mythic Tools commander scores",
        "generated_at": finished,
        "source": {
            "name": "Mythic Tools",
            "url": "https://mythic.tools",
            "attribution": "Derived from Mythic Tools' aggregate per-commander game records (mythic.tools, Studio Laganne SAS). Yama shows derived win rates and scores, not Mythic's responses.",
            "license": "No published terms; derived rates and scores only",
        },
        "method": (
            "Clean-room derivation (deliver/METHOD.md): observed win_rate is wins / all reported games (draws included in the denominator), when supplied; legacy scores do not imply an observed rate. The adjusted score uses wins and losses from Mythic's platform aggregate, "
            f"Beta prior of strength {prior:g} at the cohort mean {baseline:.4f}, effective sample min(N/4, 4 x decks, 2000); "
            f"score = 100 * logistic((logit(p) - logit(p0)) / 0.5) with a 95% credible interval. {cohort}"
        ),
        "coverage": coverage,
        "sources": [{
            "sha256": digest,
            "url": None,
            "retrieved_at": finished,
            "source_as_of": None,
            "captured_at": None,
            "flags": [],
            "transformation": "commander_scores.csv from the clean-room deliver/ hand-off; derived rates, scores and counts only",
            "original_response_sha256": None,
        }, {
            "sha256": summary_digest,
            "url": None,
            "retrieved_at": finished,
            "source_as_of": None,
            "captured_at": None,
            "flags": [],
            "transformation": "analysis_summary.json from the same hand-off: cohort baseline and prior strength",
            "original_response_sha256": None,
        }],
        "records": records,
    }
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(records)} commanders -> {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
