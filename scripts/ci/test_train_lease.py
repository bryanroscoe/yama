"""Test the release coordinator's lease (scripts/ci/train_lease.py, docs/release-trains.md).

Run from any directory: python3 -m unittest discover -s scripts/ci -p 'test_*.py'
"""

import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "train_lease.py"
sys.path.insert(0, str(HERE))
import train_lease  # noqa: E402

NOON = dt.datetime(2026, 11, 11, 12, 0, tzinfo=dt.timezone.utc)


class Lease(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.old = os.environ.get("YAMA_TRAINS_DIR")
        os.environ["YAMA_TRAINS_DIR"] = str(self.root)
        self.addCleanup(self.restore)

    def restore(self):
        if self.old is None:
            os.environ.pop("YAMA_TRAINS_DIR", None)
        else:
            os.environ["YAMA_TRAINS_DIR"] = self.old

    def do(self, *argv, now=NOON):
        return train_lease.main(list(argv), now=now)

    def file(self):
        return json.loads((self.root / "COORDINATOR.json").read_text())

    def test_one_thread_holds_the_lease_until_it_lapses_or_is_released(self):
        self.assertEqual(self.do("status"), 3)
        self.assertEqual(self.do("acquire", "--thread", "a", "--hours", "2"), 0)
        self.assertEqual(self.file()["lease_until"], "2026-11-11T14:00:00Z")
        self.assertEqual(self.do("status"), 0)
        # Another thread can't take, renew or release a live lease.
        self.assertEqual(self.do("acquire", "--thread", "b"), 1)
        self.assertEqual(self.do("renew", "--thread", "b"), 1)
        self.assertEqual(self.do("release", "--thread", "b"), 1)
        self.assertEqual(self.file()["coordinator_thread"], "a")
        # The holder renews; `since` stays.
        later = NOON + dt.timedelta(hours=1)
        self.assertEqual(self.do("renew", "--thread", "a", "--hours", "2", now=later), 0)
        self.assertEqual((self.file()["since"], self.file()["lease_until"]), ("2026-11-11T12:00:00Z", "2026-11-11T15:00:00Z"))
        # Once it lapses nobody holds it, and another thread may take it.
        lapsed = NOON + dt.timedelta(hours=4)
        self.assertEqual(self.do("status", now=lapsed), 3)
        self.assertEqual(self.do("acquire", "--thread", "b", now=lapsed), 0)
        # The old holder has lost it: no renewal, no merge.
        self.assertEqual(self.do("renew", "--thread", "a", now=lapsed), 1)
        self.assertEqual(self.do("run", "--thread", "a", "--", "true", now=lapsed), 1)
        # Releasing ends it at once.
        self.assertEqual(self.do("release", "--thread", "b", now=lapsed), 0)
        self.assertIs(self.file()["active"], False)
        self.assertEqual(self.do("status", now=lapsed), 3)

    def test_a_lapsed_or_released_lease_does_not_renew(self):
        # Nobody else has taken it, and still the old holder can't revive it and merge.
        self.do("acquire", "--thread", "a", "--hours", "1")
        lapsed = NOON + dt.timedelta(hours=2)
        self.assertEqual(self.do("renew", "--thread", "a", now=lapsed), 1)
        self.assertEqual(self.do("status", now=lapsed), 3)
        self.assertEqual(self.do("run", "--thread", "a", "--", "true", now=lapsed), 1)
        # Coordinating again is a fresh acquire, with a new start time.
        self.assertEqual(self.do("acquire", "--thread", "a", "--hours", "1", now=lapsed), 0)
        self.assertEqual(self.file()["since"], "2026-11-11T14:00:00Z")
        self.assertEqual(self.do("release", "--thread", "a", now=lapsed), 0)
        self.assertEqual(self.do("renew", "--thread", "a", now=lapsed), 1)
        self.assertEqual(self.do("run", "--thread", "a", "--", "true", now=lapsed), 1)
        self.assertIs(self.file()["active"], False)

    def test_run_needs_a_live_lease_and_passes_the_commands_status_on(self):
        self.assertEqual(self.do("run", "--thread", "a", "--", "true"), 1, "no lease at all")
        self.do("acquire", "--thread", "a", "--hours", "1")
        self.assertEqual(self.do("run", "--thread", "a", "--", sys.executable, "-c", "raise SystemExit(7)"), 7)
        self.assertEqual(self.do("run", "--thread", "a", "--", "true", now=NOON + dt.timedelta(hours=2)), 1, "lapsed")

    def test_a_malformed_or_inactive_file_is_no_lease(self):
        for text in ("", "not json", "[]", '{"active": true}', '{"active": true, "coordinator_thread": "a", "lease_until": "soon"}',
                     '{"active": false, "coordinator_thread": "a", "lease_until": "2099-01-01T00:00:00Z"}'):
            (self.root / "COORDINATOR.json").write_text(text)
            self.assertEqual(self.do("status"), 3, text)
        self.assertEqual(self.do("acquire", "--thread", "b"), 0)

    def test_a_lease_is_at_most_a_day(self):
        with self.assertRaises(SystemExit):
            self.do("acquire", "--thread", "a", "--hours", "48")

    def test_only_one_of_many_racing_threads_wins(self):
        env = {**os.environ, "YAMA_TRAINS_DIR": str(self.root)}
        racers = [subprocess.Popen([sys.executable, str(SCRIPT), "acquire", "--thread", f"t{i}"], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for i in range(12)]
        codes = [p.wait(timeout=30) for p in racers]
        self.assertEqual(codes.count(0), 1, codes)
        self.assertEqual(codes.count(1), 11, codes)
        winner = f"t{codes.index(0)}"
        self.assertEqual(self.file()["coordinator_thread"], winner)

    def test_nobody_takes_the_lease_while_the_holder_is_merging(self):
        env = {**os.environ, "YAMA_TRAINS_DIR": str(self.root)}
        subprocess.run([sys.executable, str(SCRIPT), "acquire", "--thread", "a", "--hours", "1"], env=env, check=True, capture_output=True)
        # Make the lease look lapsed on disk while the holder's command is still running: the
        # taker has to wait for the lock, so the command finishes before anyone else owns main.
        marker = self.root / "merged"
        slow = f"import time, pathlib; time.sleep(1.0); pathlib.Path({str(marker)!r}).write_text('done')"
        merging = subprocess.Popen([sys.executable, str(SCRIPT), "run", "--thread", "a", "--", sys.executable, "-c", slow], env=env)
        time.sleep(0.4)  # let the holder take the lock and start its command
        lease = self.file()
        lease["lease_until"] = "2000-01-01T00:00:00Z"
        (self.root / "COORDINATOR.json").write_text(json.dumps(lease))
        taker = subprocess.run([sys.executable, str(SCRIPT), "acquire", "--thread", "b"], env=env, capture_output=True, timeout=30)
        self.assertEqual(taker.returncode, 0)
        self.assertTrue(marker.exists(), "the lease changed hands before the holder's command finished")
        self.assertEqual(merging.wait(timeout=30), 0)


if __name__ == "__main__":
    unittest.main()
