"""Exercise release guards against temporary local Git remotes; never contact saget or GitHub.

Run from any directory: python3 deploy/test_release.py
"""

import os
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
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
            # This machine's own target file (~/.config/yama/deploy.env) must never reach a test.
            "YAMA_DEPLOY_ENV": os.devnull,
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

    def test_target_falls_back_to_this_machines_file(self):
        # A fresh worktree has no deploy/.env; the machine's file names saget once for every checkout.
        script = '. "$DEPLOY_DIR/target.sh"; printf %s "$HOST"'
        machine = self.root / "machine-deploy.env"
        machine.write_text("# saget\nYAMA_DEPLOY_HOST=192.0.2.41\nYAMA_DEPLOY_USER='deployer'\nOTHER=ignored\n")
        deploy = self.repo / "deploy"
        def host(**extra):
            env = {**self.env, "DEPLOY_DIR": str(deploy), "YAMA_DEPLOY_ENV": str(machine), **extra}
            result = subprocess.run(["sh", "-c", script], cwd=self.repo, env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        self.assertEqual(host(), "deployer@192.0.2.41")
        # The default place is under the config directory.
        config = self.root / "config"
        (config / "yama").mkdir(parents=True)
        (config / "yama" / "deploy.env").write_text("YAMA_DEPLOY_HOST=192.0.2.42\n")
        env = {k: v for k, v in self.env.items() if k != "YAMA_DEPLOY_ENV"}
        result = subprocess.run(["sh", "-c", script], cwd=self.repo, capture_output=True, text=True, timeout=15,
            env={**env, "DEPLOY_DIR": str(deploy), "XDG_CONFIG_HOME": str(config)})
        self.assertEqual((result.returncode, result.stdout), (0, "root@192.0.2.42"), result.stderr)
        # The checkout's own deploy/.env wins over the machine's file, and the environment over both.
        (deploy / ".env").write_text("YAMA_DEPLOY_HOST=192.0.2.40\n")
        self.assertEqual(host(), "deployer@192.0.2.40")
        self.assertEqual(host(YAMA_DEPLOY_HOST="192.0.2.43", YAMA_DEPLOY_USER="root"), "root@192.0.2.43")
        # An empty value in the checkout's file leaves the machine's value in place.
        (deploy / ".env").write_text("YAMA_DEPLOY_HOST=\n")
        self.assertEqual(host(), "deployer@192.0.2.41")
        (deploy / ".env").unlink()
        # A machine file that can't be read is skipped, so an explicit target still works.
        machine.chmod(0o000)
        try:
            if not os.access(machine, os.R_OK):
                self.assertEqual(host(YAMA_DEPLOY_HOST="192.0.2.43"), "root@192.0.2.43")
        finally:
            machine.chmod(0o600)

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


class FirstTimeArtifacts(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='yama-first-time-test-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.local = self.root / 'data/engine'
        self.local.mkdir(parents=True)
        self.remote = self.root / 'remote'
        self.remote.mkdir()
        deploy = self.root / 'deploy'
        deploy.mkdir()
        shutil.copyfile(SCRIPTS / 'target.sh', deploy / 'target.sh')
        (deploy / 'yama.env.example').write_text('TEST=1\n')
        text = (SCRIPTS / 'first-time.sh').read_text()
        self.files = []
        for name, digest_key in [('CARD_DATA', 'SHA'), ('HISTORICAL_CARD_DATA', 'HISTORICAL_SHA'), ('V0119_CARD_DATA', 'V0119_SHA')]:
            filename = re.search(r'^' + name + r'=(.+)$', text, re.M)[1]
            content = ('synthetic ' + name).encode()
            (self.local / filename).write_bytes(content)
            self.files.append(filename)
            text = re.sub(r'^' + digest_key + r'=[0-9a-f]{64}$',
                          digest_key + '=' + hashlib.sha256(content).hexdigest(), text, flags=re.M)
        self.script = deploy / 'first-time.sh'
        self.script.write_text(text)
        commands = self.root / 'bin'
        commands.mkdir()
        # No actual SSH/SCP. Verify uploaded bytes in a local fake server.
        stub = '''import os, pathlib, shutil, subprocess, sys
remote = pathlib.Path(os.environ['FAKE_SERVER'])
name = pathlib.Path(sys.argv[0]).name
if name == 'scp':
    target = remote / sys.argv[-1].rsplit('/', 1)[-1]
    if os.environ.get('FAIL_TRANSFER') and os.environ.get('TARGET_ARTIFACT', '!') in target.name:
        target.write_bytes(b'partial transfer')
        sys.exit(1)
    shutil.copyfile(sys.argv[-2], target)
    with (remote / 'copies.log').open('a') as stream: stream.write(target.name + '\\n')
else:
    command = sys.argv[-1]
    if '--quiet' in command and os.environ.get('TARGET_ARTIFACT', '!') in command:
        fault = os.environ.get('FAIL_CHECK')
        if fault: sys.exit(255 if fault == 'transport' else 10)
    command = command.replace('/mnt/user/appdata/yama/data/engine', str(remote))
    command = command.replace('/mnt/user/appdata/yama', str(remote))
    result = subprocess.run(['sh', '-c', command], capture_output=True, text=True)
    sys.stdout.write(result.stdout.replace(str(remote), '/mnt/user/appdata/yama/data/engine'))
    sys.stderr.write(result.stderr)
    sys.exit(result.returncode)
'''
        for name in ('ssh', 'scp'):
            path = commands / name
            path.write_text('#!' + sys.executable + '\n' + stub)
            path.chmod(0o755)
        (commands / 'chown').write_text('#!/bin/sh\nexit 0\n')
        (commands / 'chown').chmod(0o755)
        checksum = commands / 'sha256sum'
        checksum.write_text('#!' + sys.executable + '\n' + '''import hashlib, pathlib, sys
ok = True
for line in sys.stdin:
    expected, filename = line.rstrip().split('  ', 1)
    path = pathlib.Path(filename)
    ok = ok and path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected
sys.exit(0 if ok else 1)
''')
        checksum.chmod(0o755)
        if sys.platform == 'darwin':
            # Production/CI use GNU mv -T. Model its exact-destination rename
            # with the OS rename primitive on macOS, whose mv has no -T.
            move = commands / 'mv'
            move.write_text('#!' + sys.executable + '\n' + '''import os, subprocess, sys
if sys.argv[1:3] == ['-fT', '--']:
    try:
        os.replace(sys.argv[3], sys.argv[4])
    except OSError:
        sys.exit(1)
else:
    sys.exit(subprocess.run(['/bin/mv', *sys.argv[1:]]).returncode)
''')
            move.chmod(0o755)
        self.env = dict(os.environ, PATH=str(commands) + os.pathsep + os.environ['PATH'],
                        FAKE_SERVER=str(self.remote), YAMA_DEPLOY_HOST='test.invalid', YAMA_DEPLOY_USER='root',
                        YAMA_DEPLOY_ENV=os.devnull)  # never this machine's ~/.config/yama/deploy.env

    def run_setup(self):
        return subprocess.run(['sh', str(self.script)], env=self.env, capture_output=True, text=True)

    def test_fresh_server_gets_all_three_verified_artifacts(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Server prepared.', result.stdout)
        for filename in self.files:
            self.assertEqual((self.remote / filename).read_bytes(), (self.local / filename).read_bytes())

    def test_verified_existing_files_do_not_need_local_copies(self):
        for filename in self.files:
            shutil.move(self.local / filename, self.remote / filename)
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_or_corrupt_historical_source_cannot_report_ready(self):
        previous = self.local / self.files[1]
        previous.unlink()
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Server prepared.', result.stdout)
        previous.write_bytes(b'wrong historical bytes')
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Server prepared.', result.stdout)

    def test_missing_or_corrupt_v0119_source_cannot_report_ready(self):
        previous = self.local / self.files[2]
        previous.unlink()
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Server prepared.', result.stdout)
        previous.write_bytes(b'wrong v0119 bytes')
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Server prepared.', result.stdout)
        self.assertFalse((self.remote / self.files[2]).exists())

    def test_setup_hashes_match_release_manifests(self):
        text = (SCRIPTS / 'first-time.sh').read_text()
        current = json.loads((SCRIPTS / 'engine-data.json').read_text())
        historical = json.loads((SCRIPTS.parent / 'runtime/historical.json').read_text())
        self.assertIn('SHA=' + current['current_sha256'], text)
        self.assertIn('CARD_DATA=' + Path(current['current_file']).name, text)
        self.assertIn('HISTORICAL_SHA=' + historical['card_sha256'], text)
        self.assertIn('HISTORICAL_CARD_DATA=' + current['historical_file'], text)
        v0119 = json.loads((SCRIPTS.parent / 'runtime/v0119/historical.json').read_text())
        self.assertIn('V0119_SHA=' + v0119['card_sha256'], text)
        self.assertIn('V0119_CARD_DATA=' + current['historical_v0119_file'], text)

    def test_failed_check_transfer_or_verification_preserves_valid_existing_artifact(self):
        previous = self.files[1]
        original = (self.local / previous).read_bytes()
        for filename in self.files:
            shutil.copyfile(self.local / filename, self.remote / filename)
        for fault in ('transport', 'verification', 'transfer'):
            with self.subTest(fault=fault):
                (self.local / previous).write_bytes(b'corrupt local artifact')
                self.env.update(TARGET_ARTIFACT=previous,
                                FAIL_CHECK='transport' if fault == 'transport' else 'mismatch')
                if fault == 'transfer':
                    self.env['FAIL_TRANSFER'] = '1'
                result = self.run_setup()
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Server prepared.', result.stdout)
                self.assertEqual((self.remote / previous).read_bytes(), original)
                self.assertEqual(list(self.remote.glob('.' + previous + '.*')), [])
        self.assertNotIn(previous + '\n', (self.remote / 'copies.log').read_text())

    def assert_invalid_destination_is_preserved(self, kind):
        destination = self.remote / self.files[1]
        other_directory = self.root / 'other-directory'
        other_directory.mkdir()
        if kind == 'directory':
            destination.mkdir()
        else:
            destination.symlink_to(other_directory, target_is_directory=True)
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn('Server prepared.', result.stdout)
        self.assertEqual(list(destination.iterdir()), [])
        self.assertEqual(list(self.remote.glob('.' + self.files[1] + '.*')), [])
        self.assertEqual(destination.is_symlink(), kind == 'symlink')

    def test_directory_destination_cannot_report_ready(self):
        self.assert_invalid_destination_is_preserved('directory')

    def test_symlink_directory_destination_cannot_report_ready(self):
        self.assert_invalid_destination_is_preserved('symlink')


if __name__ == "__main__":
    unittest.main(verbosity=2)
