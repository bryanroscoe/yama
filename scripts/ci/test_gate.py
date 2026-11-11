"""Test the PR CI gate, its workflow wiring and scripts/local-ci.sh without GitHub.

Run from any directory: python3 -m unittest discover -s scripts/ci -p 'test_*.py'
"""

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import gate  # noqa: E402

TREE = 'a' * 40
OTHER = 'b' * 40


def job(workflow, name):
    """Return one job's text from ci.yml (jobs are two-space indented keys)."""
    match = re.search(rf'^  {name}:\n(.*?)(?=^  \S|\Z)', workflow, re.M | re.S)
    return match.group(1)


class Decision(unittest.TestCase):
    def test_matching_trailer_on_current_branch_skips(self):
        message = f'Fix a thing\n\nLocal-CI: passed tree={TREE} on Darwin/arm64\n'
        skip, reason = gate.decide(set(), message, TREE, 0)
        self.assertTrue(skip)
        self.assertIn(TREE, reason)

    def test_missing_or_other_tree_runs(self):
        for message in ('Fix a thing\n', f'Fix\n\nLocal-CI: passed tree={OTHER} on Linux/x86_64\n',
                        f'Fix\n\nLocal-CI: failed tree={TREE}\n', f'Fix\n\nLocal-CI: passed tree={TREE}0\n',
                        f'Fix\n\n  Local-CI: passed tree={TREE}\n',
                        f'Fix\n\nQuoting Local-CI: passed tree={TREE} here\n',
                        f'Fix\n\nLocal-CI: passed tree={TREE} on Linux/x86_64\n\nA later paragraph.\n'):
            with self.subTest(message=message):
                self.assertFalse(gate.decide(set(), message, TREE, 0)[0])

    def test_branch_behind_base_runs(self):
        message = f'Fix\n\nLocal-CI: passed tree={TREE} on Darwin/arm64\n'
        skip, reason = gate.decide(set(), message, TREE, 3)
        self.assertFalse(skip)
        self.assertIn('3 commit(s) behind', reason)

    def test_label_skips_anything(self):
        self.assertTrue(gate.decide({'bug', 'skip-ci'}, 'No trailer\n', TREE, 9)[0])
        self.assertFalse(gate.decide({'skip-ci-later'}, 'No trailer\n', TREE, 0)[0])

    def test_unreadable_pr_runs_ci(self):
        with tempfile.TemporaryDirectory() as temp:
            out, summary = Path(temp, 'out'), Path(temp, 'summary')
            env = {'HEAD_SHA': TREE, 'GITHUB_REPOSITORY': 'o/r', 'PR_NUMBER': '1',
                   'GH_TOKEN': 'x', 'GITHUB_API_URL': 'http://127.0.0.1:9',
                   'GITHUB_OUTPUT': str(out), 'GITHUB_STEP_SUMMARY': str(summary)}
            result = subprocess.run([sys.executable, str(HERE / 'gate.py')], env={**os.environ, **env},
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(out.read_text(), 'rust=true\nskip=false\n')
            self.assertIn('CI runs', summary.read_text())


class RustScope(unittest.TestCase):
    def test_web_only_changes_skip_rust(self):
        self.assertFalse(gate.rust_needed(['web/src/App.tsx', 'packages/core/src/a.ts',
                                           'package-lock.json']))

    def test_anything_rust_can_see_runs_rust(self):
        for files in ([], ['server/src/main.rs'], ['web/src/App.tsx', 'README.md'],
                      ['web/public/sw.js'], ['web/src/styles.css'], ['web/src/x.html'],
                      ['.github/workflows/ci.yml'], ['docs/research-format.md'],
                      ['web/src/a.ts'] * gate.MAX_FILES):
            with self.subTest(files=files[:3]):
                self.assertTrue(gate.rust_needed(files))


class PushReuse(unittest.TestCase):
    REPO = 'o/r'
    RUN = {'path': '.github/workflows/ci.yml', 'event': 'pull_request',
           'head_repository': {'full_name': 'o/r'}}
    JOBS = [{'name': 'Local CI gate', 'conclusion': 'success'},
            {'name': 'Web checks', 'conclusion': 'success'},
            {'name': 'Rust and Python tests', 'conclusion': 'success'}]

    def test_pr_run_that_passed_both_jobs_counts(self):
        self.assertTrue(gate.passed_run(self.RUN, self.JOBS, self.REPO))

    def test_anything_less_does_not(self):
        skipped_web = [dict(job, conclusion='skipped') if job['name'] == 'Web checks' else job
                       for job in self.JOBS]
        for run, jobs in ((self.RUN, skipped_web), (self.RUN, self.JOBS[:2]),
                          ({**self.RUN, 'event': 'push'}, self.JOBS),
                          ({**self.RUN, 'path': '.github/workflows/other.yml'}, self.JOBS),
                          ({**self.RUN, 'head_repository': {'full_name': 'fork/r'}}, self.JOBS)):
            with self.subTest(run=run, jobs=jobs):
                self.assertFalse(gate.passed_run(run, jobs, self.REPO))

    def test_push_reuses_only_a_passed_run_on_the_same_tree(self):
        calls = []
        responses = {
            '/repos/o/r/git/commits/' + TREE: {'tree': {'sha': OTHER}, 'parents': [{'sha': 'p'}]},
            f'/repos/o/r/compare/p...{TREE}': {'files': [{'filename': 'web/src/App.tsx'}]},
            f'/repos/o/r/actions/artifacts?per_page=30&name=ci-passed-tree-{OTHER}': {'artifacts': [
                {'name': f'ci-passed-tree-{OTHER}', 'expired': True, 'workflow_run': {'id': 1}},
                {'name': f'ci-passed-tree-{OTHER}', 'expired': False, 'workflow_run': {'id': 2}},
                {'name': f'ci-passed-tree-{OTHER}', 'expired': False, 'workflow_run': {'id': 3}}]},
            '/repos/o/r/actions/runs/2': {**self.RUN, 'event': 'push'},
            '/repos/o/r/actions/runs/2/jobs?filter=latest&per_page=100': {'jobs': self.JOBS},
            '/repos/o/r/actions/runs/3': {**self.RUN, 'html_url': 'https://example.invalid/3'},
            '/repos/o/r/actions/runs/3/jobs?filter=latest&per_page=100': {'jobs': self.JOBS},
        }

        def api(path):
            calls.append(path)
            return responses[path]

        original, gate.api = gate.api, api
        try:
            skip, reason = gate.decide_push('o/r', TREE)
        finally:
            gate.api = original
        self.assertTrue(skip)
        self.assertIn('[3]', reason)
        self.assertNotIn('/repos/o/r/actions/runs/1', calls)

    def test_push_without_a_passed_tree_runs(self):
        responses = {'/repos/o/r/git/commits/' + TREE: {'tree': {'sha': OTHER}, 'parents': [{'sha': 'p'}]},
                     f'/repos/o/r/compare/p...{TREE}': {'files': [{'filename': 'server/src/main.rs'}]},
                     f'/repos/o/r/actions/artifacts?per_page=30&name=ci-passed-tree-{OTHER}':
                         {'artifacts': []}}
        original, gate.api = gate.api, responses.__getitem__
        try:
            self.assertFalse(gate.decide_push('o/r', TREE)[0])
        finally:
            gate.api = original


class CacheKeys(unittest.TestCase):
    def test_cache_key_changes_force_a_full_main_run(self):
        for path in ('Cargo.lock', 'play/Cargo.toml', 'deploy/phase-rev', 'package-lock.json',
                     'rust-toolchain.toml', '.github/workflows/ci.yml'):
            with self.subTest(path=path):
                self.assertTrue(gate.changes_cache_key(['web/src/a.ts', path]))
        self.assertFalse(gate.changes_cache_key(['server/src/main.rs', 'web/package.json']))

    def test_push_changing_a_cache_key_runs_without_looking_for_artifacts(self):
        responses = {'/repos/o/r/git/commits/' + TREE: {'tree': {'sha': OTHER}, 'parents': [{'sha': 'p'}]},
                     f'/repos/o/r/compare/p...{TREE}': {'files': [{'filename': 'deploy/phase-rev'}]}}
        original, gate.api = gate.api, responses.__getitem__
        try:
            skip, reason = gate.decide_push('o/r', TREE)
        finally:
            gate.api = original
        self.assertFalse(skip)
        self.assertIn('cache key', reason)


class Workflow(unittest.TestCase):
    workflow = (ROOT / '.github/workflows/ci.yml').read_text()

    def test_drafts_start_no_jobs_and_ready_runs(self):
        self.assertIn('types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]',
                      self.workflow)
        self.assertIn('!github.event.pull_request.draft', job(self.workflow, 'gate'))
        for name in ('web', 'rust'):
            self.assertIn('!github.event.pull_request.draft', job(self.workflow, name))

    def test_gate_only_runs_for_trusted_pull_requests(self):
        gate_job = job(self.workflow, 'gate')
        self.assertIn("github.event_name == 'pull_request' &&", gate_job)
        self.assertIn('github.event.pull_request.head.repo.full_name == github.repository', gate_job)
        self.assertNotIn('secrets.', gate_job)
        self.assertIn('sparse-checkout: scripts/ci/gate.py', gate_job)
        # main's copy of the gate decides, not the PR's.
        self.assertIn('ref: ${{ github.event.pull_request.base.sha || github.sha }}', gate_job)
        self.assertIn('continue-on-error: true', gate_job)

    def test_main_push_ci_is_never_cancelled_by_a_newer_push(self):
        self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", self.workflow)

    def test_gate_runs_on_main_pushes_but_never_manual_runs(self):
        gate_if = re.search(r'if: >-\n(.*?)\n    # ', job(self.workflow, 'gate'), re.S).group(1)
        self.assertIn("(github.event_name == 'push' && github.ref == 'refs/heads/main') ||", gate_if)
        self.assertNotIn('workflow_dispatch', gate_if)
        self.assertIn('actions: read', job(self.workflow, 'gate'))

    def test_only_an_explicit_gate_skip_skips_a_job(self):
        # A failed or skipped gate (manual run) leaves no output, so both jobs run.
        for name in ('web', 'rust'):
            with self.subTest(job=name):
                text = job(self.workflow, name)
                self.assertIn('needs: gate', text)
                condition = re.search(r'if: >-\n(.*?)\n    runs-on', text, re.S).group(1)
                self.assertRegex(condition, r"^\s*!cancelled\(\) &&\n"
                                            r"\s*\(vars\.CI_TESTS == 'on' \|\| github\.event_name == 'workflow_dispatch'\) &&\n"
                                            r"\s*needs\.gate\.outputs\.skip != 'true' &&\n"
                                            r"\s*\(github\.event_name != 'pull_request' \|\|")
                self.assertNotIn("outputs.rust == 'true'", condition)
                self.assertNotIn("outputs.skip == 'false'", condition)
                self.assertIn('github.event.pull_request.head.repo.full_name == github.repository', condition)

    def test_tests_run_only_when_switched_on_or_started_by_hand(self):
        gate_if = re.search(r'if: >-\n(.*?)\n    # ', job(self.workflow, 'gate'), re.S).group(1)
        self.assertRegex(gate_if, r"^\s*vars\.CI_TESTS == 'on' &&\n")
        for name in ('web', 'rust'):
            with self.subTest(job=name):
                self.assertIn("(vars.CI_TESTS == 'on' || github.event_name == 'workflow_dispatch') &&",
                              job(self.workflow, name))
        android = (ROOT / '.github/workflows/android.yml').read_text()
        self.assertIn("if: vars.CI_TESTS == 'on' || github.event_name == 'workflow_dispatch'", android)

    def test_every_job_defaults_to_hosted_and_refuses_self_hosted_when_public(self):
        # The repository is public: a self-hosted runner must never take its jobs (AGENTS.md).
        for name in ('gate', 'tests-off', 'web', 'rust'):
            with self.subTest(job=name):
                text = job(self.workflow, name)
                self.assertIn("runs-on: ${{ fromJSON(vars.CI_LINUX_RUNNER || '[\"ubuntu-latest\"]') }}", text)
                first = text.split('    steps:\n', 1)[1].split('\n      - ', 1)[0]
                self.assertIn('Refuse a self-hosted runner on a public repository', first)
                self.assertIn("runner.environment == 'self-hosted' && github.event.repository.private == false", first)
        self.assertNotIn('self-hosted","Linux"', self.workflow)

    def test_main_push_succeeds_with_tests_off(self):
        # The deploy and host.py need a successful push run; an all-skipped run is "skipped".
        marker = job(self.workflow, 'tests-off')
        condition = re.search(r'if: >-\n(.*?)\n    runs-on', marker, re.S).group(1)
        self.assertIn("vars.CI_TESTS != 'on' &&", condition)
        self.assertIn("github.event_name == 'push' && github.ref == 'refs/heads/main'", condition)
        # Same backend switch and saget capacity budget as the test jobs.
        self.assertIn("runs-on: ${{ fromJSON(vars.CI_LINUX_RUNNER || '[\"ubuntu-latest\"]') }}", marker)
        self.assertIn("&& 360 || 5 }}", marker)
        self.assertIn('permissions: {}', marker)
        self.assertNotIn('needs:', marker)
        self.assertNotIn('uses:', marker)
        self.assertNotIn('secrets.', marker)

    def test_rust_job_publishes_its_tree_only_after_every_check(self):
        rust = job(self.workflow, 'rust')
        publish = rust.index('Publish the passed tree')
        self.assertGreater(publish, rust.index('Test list validation with Python optimization'))
        self.assertIn('name: ci-passed-tree-${{ steps.tested.outputs.tree }}', rust)
        self.assertIn('overwrite: true', rust)  # a re-run uploads the same name again
        self.assertEqual(rust.count("if: github.event_name == 'pull_request'"), 2)

    def test_the_rust_cache_can_keep_the_engine_build(self):
        rust = job(self.workflow, 'rust')
        # rust-cache keeps dependency builds only from paths outside the workspace root;
        # the engine is checked out at ../yama-phase, so the root must not prefix it.
        checkout = re.search(r'with:\n\s+path: (\S+)\n', rust).group(1)
        self.assertFalse('yama-phase'.startswith(checkout))
        self.assertIn(f'working-directory: {checkout}\n', rust)
        self.assertIn(f'workspaces: {checkout} -> target', rust)
        # The key keeps rust-cache's hash of the lockfile, manifests and settings, which
        # also covers every installed toolchain: only the pinned one may remain.
        self.assertNotIn('add-rust-environment-hash-key', rust)
        self.assertIn('rustup toolchain uninstall', rust)
        self.assertLess(rust.index('rustup toolchain uninstall'), rust.index('Swatinem/rust-cache'))
        self.assertLess(rust.index('rustup default 1.98.1'), rust.index('rustup toolchain uninstall'))


class LocalScript(unittest.TestCase):
    """Run scripts/local-ci.sh in a throwaway repo with every check command stubbed."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='yama-local-ci-test-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo, phase, self.bin = base / 'yama', base / 'yama-phase', base / 'bin'
        self.log = base / 'calls'
        self.env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
                    'GIT_AUTHOR_NAME': 'T', 'GIT_AUTHOR_EMAIL': 't@example.invalid',
                    'GIT_COMMITTER_NAME': 'T', 'GIT_COMMITTER_EMAIL': 't@example.invalid',
                    'PATH': f'{self.bin}{os.pathsep}{os.environ["PATH"]}', 'CALL_LOG': str(self.log),
                    'CARGO_TARGET_DIR': str(base / 'cargo-target')}
        self.bin.mkdir()
        for name in ('npm', 'cargo', 'python3'):
            self.stub(name, 0)
        self.stub('node', 0, output='22')
        self.stub('rustc', 0, output='rustc 1.98.1 (48a229cea 2026-09-01)')
        phase.mkdir()
        self.git(phase, 'init', '-q', '-b', 'main')
        self.git(phase, 'commit', '-q', '--allow-empty', '-m', 'engine')
        # The published engine repository that deploy/phase-repo names.
        self.published = base / 'published/yama-phase.git'
        self.git(base, 'clone', '-q', '--bare', str(phase), str(self.published))
        self.repo.mkdir()
        self.git(self.repo, 'init', '-q')
        (self.repo / 'deploy').mkdir()
        (self.repo / 'deploy/phase-rev').write_text(self.git(phase, 'rev-parse', 'HEAD'))
        (self.repo / 'deploy/phase-repo').write_text(f'{self.published}\n')
        (self.repo / 'scripts').mkdir()
        shutil.copy(ROOT / 'scripts/local-ci.sh', self.repo / 'scripts/local-ci.sh')
        shutil.copy(ROOT / 'deploy/check-phase.sh', self.repo / 'deploy/check-phase.sh')
        self.git(self.repo, 'add', '.')
        self.git(self.repo, 'commit', '-q', '-m', 'Change\n\nLonger body.')

    def stub(self, name, status, output=''):
        command = self.bin / name
        command.write_text(f'#!/bin/sh\necho "{name} $*" >> "$CALL_LOG"\n'
                           + (f"echo '{output}'\n" if output else '') + f'exit {status}\n')
        command.chmod(0o755)

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def run_script(self, *args):
        return subprocess.run(['bash', 'scripts/local-ci.sh', *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=60)

    def message(self):
        return self.git(self.repo, 'log', '-1', '--format=%B')

    def test_passing_checks_record_this_tree_once(self):
        tree = self.git(self.repo, 'rev-parse', 'HEAD^{tree}')
        for _ in range(2):
            result = self.run_script()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD^{tree}'), tree)
        message = self.message()
        self.assertEqual(message.count('Local-CI:'), 1, message)
        self.assertEqual(gate.attested_trees(message), {tree})
        self.assertTrue(gate.decide(set(), message, tree, 0)[0])
        self.assertIn(' node22', message)
        calls = self.log.read_text()
        for check in ('npm ci', 'npm test', 'npm run typecheck', 'npm run build', 'cargo test --locked',
                      'python3 deploy/test_release.py', 'python3 -O -m unittest'):
            self.assertIn(check, calls)

    def test_failing_check_records_nothing(self):
        self.stub('cargo', 1)
        head = self.git(self.repo, 'rev-parse', 'HEAD')
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertNotIn('Local-CI', self.message())

    def test_uncommitted_or_untracked_files_are_refused(self):
        (self.repo / 'scratch.txt').write_text('not committed')
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn('commit or remove local changes', result.stderr)
        self.assertFalse(self.log.exists())

    def test_engine_off_the_pin_is_refused(self):
        self.git(self.repo.parent / 'yama-phase', 'commit', '-q', '--allow-empty', '-m', 'newer')
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn('not at deploy/phase-rev', result.stderr)
        self.assertFalse(self.log.exists())

    def test_unpublished_engine_pin_is_refused(self):
        phase = self.repo.parent / 'yama-phase'
        self.git(phase, 'commit', '-q', '--allow-empty', '-m', 'only on this machine')
        (self.repo / 'deploy/phase-rev').write_text(self.git(phase, 'rev-parse', 'HEAD'))
        self.git(self.repo, 'commit', '-q', '-am', 'Pin an unpublished engine')
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn('engine pin must be published', result.stderr)
        self.assertNotIn('Local-CI', self.message())

    def test_other_rust_is_refused(self):
        self.stub('rustc', 0, output='rustc 1.99.0 (abc 2026-10-01)')
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn('CI uses Rust 1.98.1', result.stderr)
        self.assertNotIn('cargo', self.log.read_text())

    def test_unknown_or_extra_options_are_refused(self):
        for args in (('--amend',), ('--no-amend', 'extra')):
            with self.subTest(args=args):
                self.assertEqual(self.run_script(*args).returncode, 2)
        self.assertFalse(self.log.exists())

    def test_rust_step_rebuilds_this_worktrees_crates_under_the_lock(self):
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        calls = self.log.read_text().splitlines()
        clean = calls.index('cargo clean --quiet -p yama-server -p yama-play')
        self.assertEqual(calls[clean + 1], 'cargo test --locked')
        self.assertTrue((self.repo.parent / 'cargo-target/.yama-local-ci.lock').exists())

    def test_shared_target_is_the_default(self):
        target = self.repo.parent / 'shared-target'
        del self.env['CARGO_TARGET_DIR']
        self.env['YAMA_CARGO_TARGET_DIR'] = str(target)
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertTrue((target / '.yama-local-ci.lock').exists())

    def web_only_branch(self, path):
        # A published main, then one commit on top that changes `path`.
        (self.repo / 'scripts/ci').mkdir()
        shutil.copy(ROOT / 'scripts/ci/gate.py', self.repo / 'scripts/ci/gate.py')
        self.git(self.repo, 'add', '.')
        self.git(self.repo, 'commit', '-q', '-m', 'Gate')
        origin = self.repo.parent / 'origin.git'
        self.git(self.repo.parent, 'clone', '-q', '--bare', str(self.repo), str(origin))
        self.git(self.repo, 'remote', 'add', 'origin', str(origin))
        self.git(self.repo, 'branch', '-M', 'main')
        self.git(self.repo, 'push', '-q', 'origin', 'main')
        (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / path).write_text('change\n')
        self.git(self.repo, 'add', '.')
        self.git(self.repo, 'commit', '-q', '-m', f'Change {path}')
        # The detector runs as `python3 -I -c`; let that one reach the real interpreter.
        stub = self.bin / 'python3'
        stub.write_text(f'#!/bin/sh\necho "python3 $*" >> "$CALL_LOG"\n'
                        f'[ "$1" = -I ] && exec "{sys.executable}" "$@"\nexit 0\n')

    def test_web_only_change_skips_rust_and_python(self):
        self.web_only_branch('web/src/App.tsx')
        result = self.run_script('--no-amend')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('skipped, every change since main is web-only', result.stdout)
        calls = self.log.read_text()
        self.assertIn('npm test', calls)
        self.assertNotIn('cargo', calls)
        self.assertNotIn('python3 deploy/test_release.py', calls)

    def test_full_or_a_server_change_runs_rust(self):
        self.web_only_branch('web/src/App.tsx')
        self.assertEqual(self.run_script('--no-amend', '--full').returncode, 0)
        self.assertIn('cargo test --locked', self.log.read_text())
        self.log.unlink()
        (self.repo / 'server').mkdir()
        (self.repo / 'server/main.rs').write_text('fn main() {}\n')
        self.git(self.repo, 'add', '.')
        self.git(self.repo, 'commit', '-q', '-m', 'Server change')
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertIn('cargo test --locked', self.log.read_text())

    def test_a_failing_cargo_test_fails_the_run(self):
        # Only `cargo test` fails; `cargo clean` succeeds.
        stub = self.bin / 'cargo'
        stub.write_text('#!/bin/sh\necho "cargo $*" >> "$CALL_LOG"\n[ "$1" = test ] && exit 1\nexit 0\n')
        head = self.git(self.repo, 'rev-parse', 'HEAD')
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertIn('cargo test --locked', self.log.read_text())
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertNotIn('Local-CI', self.message())

    def test_renaming_a_server_file_into_web_runs_rust(self):
        # The server file is on main; the branch moves it under web/.
        (self.repo / 'server').mkdir()
        (self.repo / 'server/notes.txt').write_text('server side\n')
        self.web_only_branch('web/src/App.tsx')
        self.git(self.repo, 'mv', 'server/notes.txt', 'web/notes.txt')
        self.git(self.repo, 'commit', '-q', '-m', 'Move it into web')
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertIn('cargo test --locked', self.log.read_text())

    def test_a_silent_detector_means_the_full_run(self):
        self.web_only_branch('web/src/App.tsx')
        self.stub('python3', 0)
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertIn('cargo test --locked', self.log.read_text())

    def test_no_amend_leaves_head(self):
        head = self.git(self.repo, 'rev-parse', 'HEAD')
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), head)


if __name__ == '__main__':
    unittest.main()
