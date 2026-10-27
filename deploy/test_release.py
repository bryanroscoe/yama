"""Exercise release guards against temporary local Git remotes; never contact saget or GitHub.

Run from any directory: python3 deploy/test_release.py
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent


class ReleaseChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="yama-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "yama"
        self.remote = self.root / "origin.git"
        self.contact_log = self.root / "server-contact"
        commands = self.root / "bin"
        commands.mkdir()
        # Any accidental server call is intercepted, including when testing deploy.sh itself.
        for name in ("ssh", "scp", "rsync"):
            command = commands / name
            command.write_text('#!/bin/sh\nprintf contacted >> "$YAMA_RELEASE_TEST_CONTACT_LOG"\nexit 97\n')
            command.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_NAME": "Release test",
            "GIT_AUTHOR_EMAIL": "release-test@example.invalid",
            "GIT_COMMITTER_NAME": "Release test",
            "GIT_COMMITTER_EMAIL": "release-test@example.invalid",
            "YAMA_RELEASE_TEST_CONTACT_LOG": str(self.contact_log),
        }
        self.env.pop("YAMA_PHASE_DIR", None)
        phase = self.root / "yama-phase"
        self.git(self.root, "init", "--initial-branch=main", str(phase))
        (phase / "Cargo.toml").write_text("# Test engine commit\n")
        self.commit(phase, "Test engine")
        phase_rev = self.git(phase, "rev-parse", "HEAD")
        self.phase = phase
        self.phase_remote = self.root / "phase-origin.git"
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.phase_remote))
        self.git(phase, "remote", "add", "origin", str(self.phase_remote))
        self.git(phase, "push", "--set-upstream", "origin", "main")
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.git(self.root, "init", "--initial-branch=main", str(self.repo))
        (self.repo / "deploy").mkdir()
        for name in ("check-release.sh", "check-phase.sh", "deploy.sh"):
            shutil.copyfile(SCRIPTS / name, self.repo / "deploy" / name)
        (self.repo / "deploy" / "phase-rev").write_text(phase_rev + "\n")
        (self.repo / "deploy" / "phase-repo").write_text(str(self.phase_remote) + "\n")
        self.commit(self.repo, "Test release")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "--set-upstream", "origin", "main")

    def git(self, cwd, *args):
        return subprocess.run(
            ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "commit.gpgsign=false", *args],
            cwd=cwd, env=self.env, check=True, capture_output=True, text=True,
        ).stdout.strip()

    def commit(self, repo, message):
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", message)

    def advance_remote(self):
        writer = self.root / "writer"
        self.git(self.root, "clone", str(self.remote), str(writer))
        (writer / "remote-change").write_text("New GitHub work\n")
        self.commit(writer, "Remote change")
        self.git(writer, "push", "origin", "main")

    def check(self, wrapper=False):
        args = ["sh", "deploy/deploy.sh", "--check"] if wrapper else ["sh", "deploy/check-release.sh"]
        result = subprocess.run(args, cwd=self.repo, env=self.env, capture_output=True, text=True)
        self.assertFalse(self.contact_log.exists(), "A release check contacted a server")
        return result

    def rejected(self, message, wrapper=False):
        result = self.check(wrapper)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stdout + result.stderr)

    def test_clean_main_matching_remote_passes(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.git(self.repo, "rev-parse", "HEAD"))

    def test_wrapper_check_verifies_engine_without_server_calls(self):
        result = self.check(wrapper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Check only; saget was not contacted", result.stdout)

    def test_feature_branch_is_refused_by_deploy_entrypoint(self):
        self.git(self.repo, "switch", "-c", "feature/cards")
        self.rejected("deploy from main", wrapper=True)

    def test_detached_head_is_refused(self):
        self.git(self.repo, "checkout", "--detach", "HEAD")
        self.rejected("detached HEAD")

    def test_tracked_edits_are_refused(self):
        with (self.repo / "deploy" / "phase-rev").open("a") as stream:
            stream.write("unfinished\n")
        self.rejected("uncommitted or untracked")

    def test_untracked_files_are_refused(self):
        (self.repo / "unfinished-file").write_text("Not committed\n")
        self.rejected("uncommitted or untracked")

    def test_unpublished_main_is_refused(self):
        (self.repo / "local-change").write_text("Not pushed\n")
        self.commit(self.repo, "Local change")
        self.rejected("main differs")

    def test_remote_advance_is_fetched_before_comparison(self):
        old_remote = self.git(self.repo, "rev-parse", "origin/main")
        self.advance_remote()
        self.rejected("main differs")
        self.assertNotEqual(old_remote, self.git(self.repo, "rev-parse", "origin/main"))

    def test_custom_fetch_refspec_cannot_leave_main_stale(self):
        self.git(self.repo, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other")
        old_remote = self.git(self.repo, "rev-parse", "origin/main")
        self.advance_remote()
        self.rejected("main differs")
        self.assertNotEqual(old_remote, self.git(self.repo, "rev-parse", "origin/main"))

    def test_diverged_main_is_refused(self):
        (self.repo / "local-change").write_text("Local\n")
        self.commit(self.repo, "Local change")
        self.advance_remote()
        self.rejected("main differs")

    def test_unreachable_remote_is_refused(self):
        self.git(self.repo, "remote", "set-url", "origin", str(self.root / "missing.git"))
        self.rejected("couldn't refresh origin/main")

    def test_unavailable_pinned_engine_is_refused(self):
        (self.repo / "deploy" / "phase-rev").write_text("f" * 40 + "\n")
        self.commit(self.repo, "Unknown engine")
        self.git(self.repo, "push", "origin", "main")
        self.rejected("isn't a commit", wrapper=True)


    def test_unpublished_engine_commit_is_refused(self):
        (self.phase / "unpublished").write_text("Not pushed to the private engine repository\n")
        self.commit(self.phase, "Unpublished engine")
        revision = self.git(self.phase, "rev-parse", "HEAD")
        (self.repo / "deploy" / "phase-rev").write_text(revision + "\n")
        self.commit(self.repo, "Pin unpublished engine")
        self.git(self.repo, "push", "origin", "main")
        self.rejected("not published", wrapper=True)

    def test_abbreviated_engine_pin_is_refused(self):
        (self.repo / "deploy" / "phase-rev").write_text("1234567\n")
        self.commit(self.repo, "Abbreviated engine pin")
        self.git(self.repo, "push", "origin", "main")
        self.rejected("full commit SHA", wrapper=True)

    def test_selected_engine_checkout_is_used_without_changing_origin(self):
        selected = self.root / "selected-phase"
        self.git(self.root, "clone", str(self.phase_remote), str(selected))
        self.phase.rename(self.root / "unused-engine")
        self.env["YAMA_PHASE_DIR"] = str(selected)
        before = self.git(selected, "remote", "get-url", "origin")
        result = self.check(wrapper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(selected, "remote", "get-url", "origin"), before)
        self.assertEqual(self.git(selected, "status", "--porcelain"), "")

    def test_fresh_engine_fetch_is_required_even_with_cached_commit(self):
        self.phase_remote.rename(self.root / "phase-unavailable.git")
        self.rejected("couldn't refresh the engine repository", wrapper=True)

    def test_published_engine_is_fetched_when_missing_locally(self):
        writer = self.root / "phase-writer"
        self.git(self.root, "clone", str(self.phase_remote), str(writer))
        (writer / "published").write_text("New engine source\n")
        self.commit(writer, "Published engine")
        revision = self.git(writer, "rev-parse", "HEAD")
        self.git(writer, "push", "origin", "main")
        (self.repo / "deploy" / "phase-rev").write_text(revision + "\n")
        self.commit(self.repo, "Pin published engine")
        self.git(self.repo, "push", "origin", "main")
        result = self.check(wrapper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git(self.phase, "cat-file", "-e", revision + "^{commit}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
