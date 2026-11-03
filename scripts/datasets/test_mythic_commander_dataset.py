"""Derived observed rates survive conversion; an adjusted score never implies a rate."""
import csv
import json
from pathlib import Path
import runpy
import tempfile
import unittest

main = runpy.run_path(str(Path(__file__).resolve().parents[1] / "mythic-commander-dataset.py"))["main"]


class MythicRateTests(unittest.TestCase):
    def convert(self, rate=None, games=100):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            row = dict(oracle_id="11111111-1111-1111-1111-111111111111", commander="Commander", decks=10, games=games,
                       score_0_100=80, interval_low=70, interval_high=90, confidence="low", notes="Test")
            if rate is not None:
                row["win_rate"] = rate
            with (root / "commander_scores.csv").open("w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=list(row))
                writer.writeheader()
                writer.writerow(row)
            (root / "analysis_summary.json").write_text(json.dumps({"baseline": 0.3, "prior": 100, "coverage": {},
                "complete": True, "snapshot_started_at": "2026-11-02T00:00:00Z", "snapshot_finished_at": "2026-11-03T00:00:00Z"}))
            main(root, root / "out.json")
            return json.loads((root / "out.json").read_text())

    def test_observed_rate_is_preserved_separately_from_score(self):
        doc = self.convert("0.32123456789")
        self.assertEqual(doc["records"][0]["data"]["win_rate"], 0.32123456789)
        self.assertEqual(doc["records"][0]["data"]["score_0_100"], 80)
        self.assertEqual(len(doc["records"][0]["sources"]), 2)
        self.assertEqual(doc["generated_at"], "2026-11-03T00:00:00Z")
        self.assertEqual(self.convert("0")["records"][0]["data"]["win_rate"], 0)
        self.assertEqual(self.convert("1")["records"][0]["data"]["win_rate"], 1)

    def test_legacy_rate_stays_missing_and_invalid_rates_are_rejected(self):
        self.assertNotIn("win_rate", self.convert()["records"][0]["data"])
        for rate in ("nan", "inf", "-0.01", "1.01"):
            with self.subTest(rate=rate), self.assertRaises(SystemExit):
                self.convert(rate)

    def test_zero_games_cannot_supply_an_observed_rate(self):
        with self.assertRaisesRegex(SystemExit, "requires reported games"):
            self.convert("0", games=0)
