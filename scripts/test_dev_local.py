"""Check scripts/dev-local.sh's plan without building, copying or starting anything.

Run from any directory: python3 scripts/test_dev_local.py
"""

import os
from pathlib import Path
import subprocess
import unittest


SCRIPT = Path(__file__).resolve().parent / "dev-local.sh"
ROOT = SCRIPT.parent.parent

# Each is a background job or outbound caller `serve` would otherwise start; server/src/routes.rs.
OFF = {
    "YAMA_AUTO_IMPORT": "0",
    "YAMA_DECK_CHECKS": "0",
    "YAMA_LAB_THREADS": "0",
    "YAMA_MYTHIC_BRIDGE": "0",
    "YAMA_PUBLIC_URL": "",
    "YAMA_FORGE_URL": "",
    "YAMA_ADVISOR_URL": "",
    "YAMA_CF_ACCESS_TEAM": "",
    "YAMA_OFFLINE": "1",
}


class DevLocal(unittest.TestCase):
    def run_script(self, *args):
        env = {**os.environ, "YAMA_DEPLOY_HOST": "", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.run(["bash", str(SCRIPT), *args], cwd=ROOT, env=env, capture_output=True, text=True)

    def test_dry_run_turns_every_background_job_off_and_changes_nothing(self):
        before = (ROOT / "data").exists() and sorted(p.name for p in (ROOT / "data").iterdir())
        done = self.run_script("--dry-run")
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = {line.strip() for line in done.stdout.splitlines()}
        for key, value in OFF.items():
            self.assertIn(f"{key}={value}", lines)
        self.assertIn("YAMA_DEV_LOGIN=1", lines)
        for line in ("YAMA_DECK_LINK_SOURCES=", "VITE_API_BASE=", "VITE_RELAY_URL=", "VITE_PUBLIC_URL=http://localhost:5173"):
            self.assertIn(line, lines)
        self.assertIn("YAMA_BIND=127.0.0.1:8787", lines)
        self.assertIn("dry run: nothing was copied, built or started", done.stdout)
        after = (ROOT / "data").exists() and sorted(p.name for p in (ROOT / "data").iterdir())
        self.assertEqual(before, after)

    def test_dry_run_plans_screenshots_with_paths_and_extra_arguments(self):
        done = self.run_script("--dry-run", "--email", "Someone@Example.com", "--shots", "/decks", "/cards", "--", "--viewports", "mobile")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(
            "npm run polish -- shoot --base http://localhost:5173 --as someone@example.com --viewports mobile /decks /cards",
            done.stdout,
        )
        self.assertIn("YAMA_ADMIN_EMAILS=someone@example.com", done.stdout)

    def test_unknown_option_and_bad_email_are_refused(self):
        self.assertNotEqual(self.run_script("--dry-run", "--nope").returncode, 0)
        self.assertNotEqual(self.run_script("--dry-run", "--email", "nobody").returncode, 0)


if __name__ == "__main__":
    unittest.main()
