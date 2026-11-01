"""Exercise release guards against temporary local Git remotes; never contact saget or GitHub.

Run from any directory: python3 deploy/test_release.py
"""

import os
from pathlib import Path
import re
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
        for name in ("YAMA_PHASE_DIR", "YAMA_DEPLOY_HOST", "YAMA_DEPLOY_USER"):
            self.env.pop(name, None)
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
        for name in ("check-release.sh", "check-phase.sh", "deploy.sh", "target.sh"):
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

    def test_deploy_requests_exact_revision_from_shared_host_gate(self):
        capture = self.root / "server-release-command"
        (self.root / "bin/ssh").write_text('''#!/bin/sh
printf '%s' "$*" > "$YAMA_RELEASE_TEST_CAPTURE"
cat > /dev/null
exit 97
''')
        # The target comes from the gitignored deploy/.env; never a tracked address.
        (self.repo / "deploy" / ".env").write_text("YAMA_DEPLOY_HOST=192.0.2.40\n")
        (self.repo / ".git" / "info" / "exclude").write_text("deploy/.env\n")
        result = subprocess.run(["sh", "deploy/deploy.sh"], cwd=self.repo,
            env={**self.env, "GH_TOKEN": "test-token-not-a-real-secret", "YAMA_RELEASE_TEST_CAPTURE": str(capture)},
            capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 97, result.stdout + result.stderr)
        revision = self.git(self.repo, "rev-parse", "HEAD")
        self.assertIn("root@192.0.2.40 /mnt/user/appdata/yama-release/host.py deploy " + revision, capture.read_text())
        self.assertNotIn("test-token", capture.read_text() + result.stdout + result.stderr)

    def test_deploy_without_a_target_stops_before_contacting_a_server(self):
        result = subprocess.run(["sh", "deploy/deploy.sh"], cwd=self.repo,
            env={**self.env, "GH_TOKEN": "test-token-not-a-real-secret"}, capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("YAMA_DEPLOY_HOST is not set", result.stderr)
        self.assertFalse(self.contact_log.exists(), "deploy contacted a server without a configured target")
        result = subprocess.run(["sh", "deploy/deploy.sh"], cwd=self.repo,
            env={**self.env, "GH_TOKEN": "test-token-not-a-real-secret", "YAMA_DEPLOY_HOST": "-oProxyCommand=x"},
            capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.contact_log.exists(), "deploy passed an option as the host")

    def test_tracked_files_hold_no_lan_addresses(self):
        # saget's address and other LAN details live in the gitignored deploy/.env and the
        # deploy secrets. Examples use RFC 5737 documentation addresses (192.0.2.0/24).
        top = SCRIPTS.parent
        if not (top / ".git").exists():
            self.skipTest("not a Git checkout")
        files = subprocess.run(["git", "ls-files", "-z"], cwd=top, check=True, capture_output=True).stdout
        pattern = re.compile(rb"(?<![0-9.])192\.168\.[0-9]{1,3}\.[0-9]{1,3}(?![0-9])")
        found = [name.decode() for name in files.split(b"\0") if name and (top / name.decode()).is_file()
                 and pattern.search((top / name.decode()).read_bytes())]
        self.assertEqual(found, [])

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

    def test_engine_commit_on_an_archive_tag_is_published(self):
        (self.phase / "archived").write_text("Engine line kept after main was rebased\n")
        self.commit(self.phase, "Archived engine")
        revision = self.git(self.phase, "rev-parse", "HEAD")
        self.git(self.phase, "tag", "archive/pre-sync-test", revision)
        self.git(self.phase, "push", "origin", "refs/tags/archive/pre-sync-test")
        (self.repo / "deploy" / "phase-rev").write_text(revision + "\n")
        self.commit(self.repo, "Pin archived engine")
        self.git(self.repo, "push", "origin", "main")
        result = self.check(wrapper=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_engine_commit_on_another_tag_is_refused(self):
        (self.phase / "tagged").write_text("Tagged outside archive/\n")
        self.commit(self.phase, "Other tag")
        revision = self.git(self.phase, "rev-parse", "HEAD")
        self.git(self.phase, "tag", "preview-test", revision)
        self.git(self.phase, "push", "origin", "refs/tags/preview-test")
        (self.repo / "deploy" / "phase-rev").write_text(revision + "\n")
        self.commit(self.repo, "Pin other tag")
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
