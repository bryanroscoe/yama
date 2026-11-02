"""Exercise scripts/sync-main.sh against temporary local Git repositories; never contacts GitHub.

Run from any directory: python3 scripts/test_sync_main.py
"""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "sync-main.sh"


class SyncMain(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="yama-sync-main-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
        }
        self.remote = self.root / "origin.git"
        self.git(self.root, "init", "--quiet", "--bare", "--initial-branch=main", str(self.remote))
        self.pusher = self.root / "pusher"
        self.git(self.root, "clone", "--quiet", str(self.remote), str(self.pusher))
        self.git(self.pusher, "checkout", "--quiet", "-b", "main")
        (self.pusher / "package-lock.json").write_text("one\n")
        (self.pusher / "deploy").mkdir()
        (self.pusher / "deploy" / "phase-rev").write_text("a" * 40 + "\n")
        self.commit(self.pusher, "first")
        self.git(self.pusher, "push", "--quiet", "origin", "main")
        self.primary = self.root / "yama"
        self.git(self.root, "clone", "--quiet", str(self.remote), str(self.primary))

    def git(self, cwd, *args):
        done = subprocess.run(["git", *args], cwd=cwd, env=self.env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def commit(self, repo, message, name="file.txt", text=None):
        (repo / name).write_text(text if text is not None else message + "\n")
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "--quiet", "-m", message)

    def publish(self, message, **kwargs):
        """A merged PR: a new commit on origin/main that the primary checkout hasn't fetched."""
        self.commit(self.pusher, message, **kwargs)
        self.git(self.pusher, "push", "--quiet", "origin", "main")
        return self.git(self.pusher, "rev-parse", "HEAD")

    def sync(self, *args, cwd=None):
        return subprocess.run(
            ["bash", str(SCRIPT), *args], cwd=cwd or self.root, env=self.env, capture_output=True, text=True
        )

    def head(self):
        return self.git(self.primary, "rev-parse", "HEAD")

    def test_fast_forwards_main(self):
        new = self.publish("second")
        done = self.sync(str(self.primary))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.head(), new)
        self.assertEqual(self.git(self.primary, "symbolic-ref", "--short", "HEAD"), "main")
        self.assertIn("second", done.stdout)

    def test_already_current_changes_nothing(self):
        before = self.head()
        done = self.sync(str(self.primary))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.head(), before)
        self.assertIn("already at origin/main", done.stdout)

    def test_detached_head_moves_to_origin_main(self):
        self.git(self.primary, "checkout", "--quiet", "--detach")
        new = self.publish("second")
        done = self.sync(str(self.primary))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.head(), new)
        self.assertEqual(self.git(self.primary, "branch", "--show-current"), "")

    def test_finds_the_primary_checkout_from_a_worktree(self):
        worktree = self.root / "task"
        self.git(self.primary, "worktree", "add", "--quiet", "--detach", str(worktree))
        new = self.publish("second")
        done = self.sync(cwd=worktree)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.head(), new)

    def test_reports_package_lock_and_engine_hints(self):
        self.publish("lockfile", name="package-lock.json", text="two\n")
        done = self.sync(str(self.primary))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("package-lock.json changed", done.stdout)
        self.assertIn("no engine checkout", done.stdout)
        phase = self.root / "yama-phase"
        self.git(self.root, "init", "--quiet", str(phase))
        self.commit(phase, "engine")
        done = self.sync(str(self.primary))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("not deploy/phase-rev", done.stdout)
        self.assertNotIn("package-lock.json changed", done.stdout)

    def test_dirty_checkout_is_refused_and_left_alone(self):
        new = self.publish("second")
        before = self.head()
        (self.primary / "package-lock.json").write_text("edited\n")
        (self.primary / "scratch.txt").write_text("mine\n")
        done = self.sync(str(self.primary))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("package-lock.json", done.stderr)
        self.assertIn("scratch.txt", done.stderr)
        self.assertEqual(self.head(), before)
        self.assertNotEqual(before, new)
        self.assertEqual((self.primary / "package-lock.json").read_text(), "edited\n")
        self.assertEqual((self.primary / "scratch.txt").read_text(), "mine\n")

    def test_ignored_files_do_not_count_as_dirty(self):
        (self.pusher / ".gitignore").write_text("node_modules/\n")
        self.git(self.pusher, "add", "-A")
        self.git(self.pusher, "commit", "--quiet", "-m", "ignore")
        self.git(self.pusher, "push", "--quiet", "origin", "main")
        self.git(self.primary, "pull", "--quiet")
        (self.primary / "node_modules").mkdir()
        (self.primary / "node_modules" / "x").write_text("x\n")
        new = self.publish("second")
        done = self.sync(str(self.primary))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.head(), new)

    def test_other_branch_is_refused(self):
        self.git(self.primary, "checkout", "--quiet", "-b", "feature/x")
        self.commit(self.primary, "wip")
        before = self.head()
        self.publish("second")
        done = self.sync(str(self.primary))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("feature/x", done.stderr)
        self.assertEqual(self.head(), before)
        self.assertEqual(self.git(self.primary, "branch", "--show-current"), "feature/x")

    def test_detached_commits_origin_lacks_are_not_dropped(self):
        self.git(self.primary, "checkout", "--quiet", "--detach")
        self.commit(self.primary, "local only")
        before = self.head()
        self.publish("second")
        done = self.sync(str(self.primary))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("does not contain", done.stderr)
        self.assertEqual(self.head(), before)

    def test_diverged_main_is_refused(self):
        self.commit(self.primary, "local main")
        before = self.head()
        self.publish("second")
        done = self.sync(str(self.primary))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("fast-forward", done.stderr)
        self.assertEqual(self.head(), before)

    def test_unreachable_origin_stops(self):
        self.git(self.primary, "remote", "set-url", "origin", str(self.root / "missing.git"))
        before = self.head()
        done = self.sync(str(self.primary))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("couldn't fetch origin", done.stderr)
        self.assertEqual(self.head(), before)


if __name__ == "__main__":
    unittest.main()
