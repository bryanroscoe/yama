import json
import os
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import lab_worker as worker


class WorkerTests(unittest.TestCase):
    def test_spool_survives_lost_ack_and_retries_identical_payload(self):
        class API:
            def __init__(self):
                self.calls = []

            def request(self, path, body):
                self.calls.append((path, body))
                if len(self.calls) == 1:
                    raise urllib.error.URLError("connection lost after server committed")
                return {"accepted": True}

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lease.pending"
            state = dict(lease={"id": "lease"}, results=[{"game": "a"}], wall_seconds=2,
                peak_rss_bytes=100, setup_seconds=1)
            worker.save(path, state)
            api = API()
            with self.assertRaises(urllib.error.URLError):
                worker.upload(api, path, state)
            self.assertTrue(path.exists())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            worker.upload(api, path, json.loads(path.read_text()))
            self.assertFalse(path.exists())
            self.assertEqual(api.calls[0], api.calls[1])

    def test_expired_upload_is_preserved_without_retrying_as_new_work(self):
        class API:
            def request(self, *args):
                raise urllib.error.HTTPError("https://test", 409, "expired", {}, None)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lease.pending"
            state = dict(lease={"id": "lease"}, results=[], wall_seconds=0, peak_rss_bytes=0, setup_seconds=0)
            worker.save(path, state)
            worker.upload(API(), path, state)
            self.assertFalse(path.exists())
            self.assertTrue(path.with_suffix(".stale").exists())

    def test_game_child_gets_no_worker_credentials_and_reports_its_own_rss(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "fake-runner"
            binary.write_text("#!/bin/sh\ntest -z \"$YAMA_WORKER_SECRET\" || exit 12\ncat >/dev/null\nprintf '%s' '{\"game\":\"a\"}'\n")
            binary.chmod(0o700)
            request = {"spec": {"game": "a", "max_seconds": 1}}
            lease = {"id": "lease", "heartbeat_seconds": 30, "build": {"runner": "fixture/worker-rss-2048m-v1"}}
            with patch.dict(os.environ, {"YAMA_WORKER_SECRET": "must-stay-in-parent"}):
                result, rss = worker.play(None, binary, Path("unused"), request, lease)
            self.assertEqual(result, {"game": "a", "runner": "fixture/worker-rss-2048m-v1"})
            self.assertGreater(rss, 0)

    def test_capacity_guard_and_https_policy(self):
        class Args:
            max_load = 2
            min_free_mb = 2560

        with patch.object(worker.os, "getloadavg", return_value=(1, 1, 1)), patch.object(worker, "free_memory_mb", return_value=4096):
            self.assertTrue(worker.ready(Args()))
        with patch.object(worker.os, "getloadavg", return_value=(3, 3, 3)), patch.object(worker, "free_memory_mb", return_value=4096):
            self.assertFalse(worker.ready(Args()))
        with self.assertRaises(ValueError):
            worker.API("http://production.test", "unused")
        with self.assertRaises(ValueError):
            worker.API("https://secret@production.test", "unused")

    def test_memory_guard_kills_game_and_returns_unscored_error(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "stuck-runner"
            binary.write_text("#!/bin/sh\n/bin/sleep 30\n")
            binary.chmod(0o700)
            request = {"spec": {"game": "a", "seed": 1, "decks": ["a", "b"], "difficulty": "Easy", "max_seconds": 1}}
            lease = {"id": "lease", "heartbeat_seconds": 30,
                "build": {"engine": "test", "card_data": "test", "runner": "test/worker-rss-1m-v1"}}
            with patch.object(worker, "process_rss", return_value=2 * 1024**2):
                result, _ = worker.play(None, binary, Path("unused"), request, lease, max_game_mb=1)
            self.assertEqual(result["end"], "error")
            self.assertIn("RSS memory limit", result["error"])
            self.assertIsNone(result["winner"])


if __name__ == "__main__":
    unittest.main()
