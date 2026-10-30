"""Tests for the Forge worker without Forge: a fake install and card index stand in.

  python3 forge-worker/test_worker.py
"""
import json
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import forge_runner as F  # noqa: E402
import worker as W  # noqa: E402

# Deck files go to a scratch folder, never next to a checkout.
_SCRATCH = tempfile.TemporaryDirectory()
F.DECK_CACHE = Path(_SCRATCH.name) / "forge-decks"
F.WORK_ROOT = Path(_SCRATCH.name) / "forge-work"

SECRET = "s" * 40
NAMES = {
    F.norm_name("Ghave, Guru of Spores"): ["Ghave, Guru of Spores", ""],
    F.norm_name("Forest"): ["Forest", ""],
    F.norm_name("Lim-Dûl's Vault"): ["Lim-Dûl's Vault", ""],
    F.norm_name("Delver of Secrets"): ["Delver of Secrets", ""],
    F.norm_name("Fire // Ice"): ["Fire // Ice", ""],
}
FORGE = SimpleNamespace(engine="forge 9.9", card_data="forge res 9.9", version="9.9")


def spec(game="g1"):
    return {"game": game, "seed": 7, "decks": ["base", "o1"], "difficulty": "Easy", "max_turns": 120, "max_actions": 1,
            "max_seconds": 900}


def deck(i, cards):
    return {"id": i, "cards": [{"name": n, "qty": q, "commander": c} for n, q, c in cards]}


GOOD = [("Ghave, Guru of Spores", 1, True), ("Forest", 99, False)]


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.w = W.Worker(FORGE, NAMES, slots=2)

    def test_names_resolve_like_forge_with_accents_and_front_faces(self):
        self.assertEqual(self.w.resolve("Lim-Dul's Vault"), "Lim-Dûl's Vault")
        self.assertEqual(self.w.resolve("Delver of Secrets // Insectile Aberration"), "Delver of Secrets")
        self.assertEqual(self.w.resolve("Fire // Ice"), "Fire // Ice")
        self.assertIsNone(self.w.resolve("Mystery Card"))
        self.assertEqual(self.w.check(["Forest", "Mystery Card", "fire // ice"]), ["Mystery Card"])

    def test_requests_must_match_the_schedule_line(self):
        with self.assertRaises(W.BadRequest):
            self.w.play({"key": "", "spec": spec(), "decks": []})
        with self.assertRaises(W.BadRequest):
            self.w._job({"key": "k", "spec": spec(), "profile": "Random", "decks": [deck("base", GOOD), deck("o1", GOOD)]})
        with self.assertRaises(W.BadRequest):
            self.w._job({"key": "k", "spec": spec(), "decks": [deck("o1", GOOD), deck("base", GOOD)]})
        job, profile, _ = self.w._job({"key": "k", "spec": spec(), "decks": [deck("base", GOOD), deck("o1", GOOD)]})
        self.assertEqual((job["game"], profile), ("g1", "Default"))

    def test_a_deck_with_cards_forge_doesnt_know_is_a_deck_error_not_a_game(self):
        r = self.w.play({"key": "k1", "spec": spec(), "decks": [deck("base", GOOD + [("Mystery Card", 1, False)]), deck("o1", GOOD)]})
        self.assertEqual(r["end"], "error")
        self.assertTrue(r["error"].startswith(F.DECK_ERRORS) and "Mystery Card" in r["error"], r["error"])
        self.assertEqual((r["engine"], r["actions"], r["game"], r["decks"]), ("forge 9.9", 0, "g1", ["base", "o1"]))
        self.assertEqual(set(r), set(W.RESULT_KEYS))

    def test_a_repeated_key_is_answered_once(self):
        calls = []

        def fake_play(req):
            calls.append(req["key"])
            time.sleep(0.2)
            return {"game": req["spec"]["game"], "end": "win"}

        self.w._play = fake_play
        req = {"key": "same", "spec": spec(), "decks": []}
        out = []
        threads = [threading.Thread(target=lambda: out.append(self.w.play(req))) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(calls, ["same"])
        self.assertEqual([o["end"] for o in out], ["win"] * 3)
        self.assertEqual(self.w.play(req)["end"], "win")
        self.assertEqual(calls, ["same"])

    def test_seeds_reach_forge_as_non_negative_java_longs_and_results_keep_yamas(self):
        big = 16040108315156595531  # a Java long below zero: Forge would read "-s -24..." as a flag
        job, _, _ = self.w._job({"key": "k", "spec": {**spec(), "seed": big}, "decks": [deck("base", GOOD), deck("o1", GOOD)]})
        self.assertGreaterEqual(F.java_long(job["seed"]), 0)
        self.assertEqual(job["seed"], W.forge_seed(big))
        r = self.w.play({"key": "k2", "spec": {**spec(), "seed": big}, "decks": [deck("base", GOOD + [("Mystery Card", 1, False)]), deck("o1", GOOD)]})
        self.assertEqual(r["seed"], big)

    def test_results_are_shaped_for_yama(self):
        r = W.Worker._shape({"game": "g", "seed": 1, "actions": None, "ms": 12.7, "placements": None, "end": "win"})
        self.assertEqual((r["actions"], r["ms"], r["placements"], r["eliminations"], r["final_life"], r["turns"]), (0, 12, [], [], [], 0))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), W.make_handler(W.Worker(FORGE, NAMES), SECRET))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def call(self, method, path, body=None, secret=SECRET):
        req = urllib.request.Request(self.base + path, method=method, data=json.dumps(body).encode() if body is not None else None)
        if secret:
            req.add_header("x-forge-secret", secret)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_everything_but_health_needs_the_secret(self):
        self.assertEqual(self.call("GET", "/health", secret=None)[0], 200)
        self.assertEqual(self.call("GET", "/status", secret=None)[0], 401)
        self.assertEqual(self.call("GET", "/status", secret="x" * 40)[0], 401)
        self.assertEqual(self.call("POST", "/check", {"names": []}, secret=None)[0], 401)
        code, status = self.call("GET", "/status")
        self.assertEqual(code, 200)
        self.assertEqual((status["engine"], status["slots"]), ("forge 9.9", 2))
        self.assertIn("Reckless", status["profiles"])

    def test_check_and_bad_requests(self):
        self.assertEqual(self.call("POST", "/check", {"names": ["Forest", "Nope"]}), (200, {"unknown": ["Nope"]}))
        self.assertEqual(self.call("POST", "/check", {"names": "Forest"})[0], 400)
        self.assertEqual(self.call("POST", "/play", {"key": "k"})[0], 400)
        self.assertEqual(self.call("POST", "/nowhere", {})[0], 404)


class ForgeDistTests(unittest.TestCase):
    """The worker image's Forge: Yama's own build, pinned in deploy/Dockerfile.forge-worker."""

    def test_the_runner_reads_a_dist_folder_and_its_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "forge-2.0.16-745401a4+yama2"
            (d / "res/cardsfolder").mkdir(parents=True)
            (d / "res/cardsfolder/cardsfolder.zip").write_bytes(b"")
            (d / "forge-gui-desktop-2.0.16-745401a4+yama2-jar-with-dependencies.jar").write_bytes(b"")
            current = Path(tmp) / "current"
            current.symlink_to(d)  # the image's FORGE_DIR is /opt/forge/current
            forge = F.Forge(current, "java")
            self.assertEqual((forge.engine, forge.card_data),
                             ("forge 2.0.16-745401a4+yama2", "forge res 2.0.16-745401a4+yama2"))

    def test_the_dockerfile_pins_one_dist_by_sha256(self):
        text = (Path(__file__).resolve().parent.parent / "deploy/Dockerfile.forge-worker").read_text()
        name = re.findall(r"^ARG FORGE_DIST=([a-z0-9]+)$", text, re.M)
        sha = re.findall(r"^ARG FORGE_DIST_SHA256=([0-9a-f]{64})$", text, re.M)
        self.assertEqual((len(name), len(sha)), (1, 1))
        self.assertIn("ENV FORGE_DIR=/opt/forge/current", text)
        self.assertNotIn("releases/download", text)  # no unpinned Forge download


if __name__ == "__main__":
    unittest.main()
