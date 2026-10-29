"""Check the actual startup SQL's replay semantics and bound its work on a large field."""
import json
from pathlib import Path
import re
import sqlite3
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "server/src/lab/worker.rs"
SQL = re.search(r'const SPLIT_PODS: &str = "(.*?)";', SOURCE.read_text(), re.S).group(1)
CURRENT = ("engine", "cards", "current")
OLD = json.dumps({"engine": "engine", "card_data": "cards", "runner": "old"})
OTHER = json.dumps({"engine": "other-engine", "card_data": "cards", "runner": "old"})
NOW = json.dumps(dict(zip(("engine", "card_data", "runner"), CURRENT)))


class SplitPods(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE lab_experiments(id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE lab_execution_runs(experiment_id TEXT, comparison INTEGER);
            CREATE INDEX lab_execution_production ON lab_execution_runs(experiment_id, comparison);
            CREATE TABLE lab_experiment_games(
                experiment_id TEXT, game TEXT, engine TEXT, ord INTEGER,
                result TEXT, end_kind TEXT, finished_at TEXT, attempts INTEGER,
                PRIMARY KEY(experiment_id, game));
            INSERT INTO lab_experiments VALUES('run','running');
        """)

    def add(self, ord_, result, *, engine="phase", attempts=1):
        self.db.execute("INSERT INTO lab_experiment_games VALUES(?,?,?,?,?,?,?,?)",
                        ("run", f"{engine}-{ord_}", engine, ord_, result, "win", "date", attempts))

    def replay(self):
        before = self.db.total_changes
        self.db.execute(SQL, ("run", 3, "run", *CURRENT))
        return self.db.total_changes - before

    def test_replays_only_incompatible_incomplete_or_mixed_pairs(self):
        for ord_, result in [(0, OLD), (1, None), (2, OLD), (3, OLD),
                             (4, OLD), (5, OTHER), (6, NOW), (7, OLD),
                             (8, OLD), (9, "not json"), (10, OLD), (11, None)]:
            self.add(ord_, result, attempts=3 if ord_ == 10 else 1)
        self.add(0, OLD, engine="forge")
        self.add(1, None, engine="forge")
        self.assertEqual(self.replay(), 5)
        rows = {ord_: (result, attempts, end, at) for ord_, result, attempts, end, at in self.db.execute(
            "SELECT ord,result,attempts,end_kind,finished_at FROM lab_experiment_games WHERE engine='phase'")}
        for ord_ in (0, 4, 5, 7, 10):
            self.assertEqual(rows[ord_], (None, 3 if ord_ == 10 else 0, None, None))
        for ord_ in (2, 3, 6, 8, 9):
            self.assertIsNotNone(rows[ord_][0])
        self.assertEqual(self.db.execute("SELECT result FROM lab_experiment_games WHERE engine='forge' AND ord=0").fetchone()[0], OLD)

    def test_finished_and_remotely_routed_runs_are_untouched(self):
        self.add(0, OLD)
        self.add(1, None)
        self.db.execute("UPDATE lab_experiments SET status='done'")
        self.assertEqual(self.replay(), 0)
        self.db.execute("UPDATE lab_experiments SET status='running'")
        self.db.execute("INSERT INTO lab_execution_runs VALUES('run',0)")
        self.assertEqual(self.replay(), 0)

    def test_large_field_does_not_take_quadratic_pairing_work(self):
        # A VM instruction budget catches the production lock regression without
        # depending on wall time or the CI runner's CPU speed.
        self.db.executemany("INSERT INTO lab_experiment_games VALUES(?,?,?,?,?,?,?,?)", (
            ("run", str(i), "phase", i, OLD if i % 2 == 0 else None, "win", "date", 1)
            for i in range(10000)))
        steps = 0

        def progress():
            nonlocal steps
            steps += 1000
            return steps > 10_000_000

        self.db.set_progress_handler(progress, 1000)
        self.assertEqual(self.replay(), 5000)
        self.db.set_progress_handler(None, 0)
        self.assertLess(steps, 10_000_000)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM lab_experiment_games WHERE result IS NOT NULL").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
