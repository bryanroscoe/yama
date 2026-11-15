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
                                    cwd=ROOT, capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(out.read_text(), 'web=true\nrust=true\npython=true\nskip=false\n')
            self.assertIn('CI runs', summary.read_text())


# A small tree for the scan: each area's code names files in the others.
SOURCES = {
    'server/src/page.rs': 'const CSS: &str = include_str!("../../web/src/styles.css");\n'
                          'fn a<\'a>(x: &\'a str) { std::fs::read_to_string("../docs/notes.md"); }\n'
                          'fn card(id: &str) -> String { format!("../data/engine/card-data-{id}.json") }\n'
                          'const WORD: &str = "web"; const URL: &str = "/docs/mcp/";\n',
    'play/build.rs': 'println!("cargo:rerun-if-changed=../runtime/historical.json");\n',
    'web/src/nav.test.tsx': 'readFileSync(new URL("../../server/src/public_page.rs", import.meta.url));\n'
                            "readFileSync(join(ROOT, 'LICENSE')); readFileSync('../../deploy/Dockerfile');\n",
    'forge-worker/common.py': 'LAB_DOCS = ROOT / "docs/lab"\n',
    'scripts/ci/test_gate.py': "files = ['web/src/App.tsx']\n",
}
OTHER_FILES = ['web/src/styles.css', 'web/src/App.tsx', 'web/src/pages/list.css', 'docs/notes.md',
               'docs/lab/run.md', 'docs/other.md', 'data/engine/card-data-1.json',
               'runtime/historical.json', 'server/src/public_page.rs', 'LICENSE', 'deploy/Dockerfile',
               'deploy/deploy.sh', 'README.md']


class Areas(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='yama-gate-scan-')
        root = Path(cls.temp.name)
        for path in [*SOURCES, *OTHER_FILES]:
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_text(SOURCES.get(path, 'x\n'))
        cls.reads = gate.cross_reads(root, [*SOURCES, *OTHER_FILES])

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def needs(self, *files):
        return gate.areas_needed(list(files), self.reads)

    def test_each_area_needs_its_own_files(self):
        self.assertEqual(self.needs('web/src/App.tsx', 'packages/core/src/a.ts', 'package-lock.json'),
                         {'web'})
        self.assertEqual(self.needs('relay/src/room.ts', 'extension/mpc/order.mjs'), {'web'})
        self.assertEqual(self.needs('server/src/main.rs'), {'rust', 'python'})
        self.assertEqual(self.needs('Cargo.lock'), {'rust', 'python'})
        self.assertEqual(self.needs('deploy/phase-rev'), {'rust', 'python'})
        self.assertEqual(self.needs('deploy/deploy.sh', 'tools/lab.py'), {'python'})

    def test_documentation_nothing_reads_needs_no_job(self):
        self.assertEqual(self.needs('README.md', 'docs/other.md', 'design/tokens.md'), set())

    def test_a_file_another_area_reads_needs_that_area(self):
        # The server compiles in this stylesheet, but not every stylesheet.
        self.assertEqual(self.needs('web/src/styles.css'), {'web', 'rust'})
        self.assertEqual(self.needs('web/src/pages/list.css'), {'web'})
        self.assertEqual(self.needs('docs/notes.md'), {'rust'})
        self.assertEqual(self.needs('docs/lab/run.md'), {'python'})
        self.assertEqual(self.needs('data/engine/card-data-1.json'), {'rust', 'python'})
        self.assertEqual(self.needs('runtime/historical.json'), {'rust', 'python'})
        self.assertEqual(self.needs('server/src/public_page.rs'), {'web', 'rust', 'python'})
        self.assertEqual(self.needs('LICENSE'), {'web'})
        self.assertEqual(self.needs('deploy/Dockerfile'), {'web', 'python'})

    def test_words_urls_and_test_data_are_not_reads(self):
        # "web" in Rust, "/docs/mcp/" (a URL) and the gate's own test data name nothing.
        self.assertEqual(self.needs('web/src/App.tsx'), {'web'})
        self.assertEqual(self.needs('docs/other.md'), set())

    def test_unknown_changes_need_everything(self):
        for files, reads in (([], self.reads), (['web/src/a.ts'] * gate.MAX_FILES, self.reads),
                             (['README.md'], None), (['.github/workflows/ci.yml'], self.reads)):
            with self.subTest(files=files[:2], reads=reads is not None):
                self.assertEqual(gate.areas_needed(files, reads), set(gate.AREAS))

    def test_a_deleted_file_still_named_by_code_needs_that_area(self):
        # The tree after the change no longer has the file, but the server still embeds it.
        files = [f for f in [*SOURCES, *OTHER_FILES] if f != 'web/src/styles.css']
        reads = gate.cross_reads(Path(self.temp.name), files)
        self.assertEqual(gate.areas_needed(['web/src/styles.css'], reads), {'web'})
        reads = gate.cross_reads(Path(self.temp.name), files, gone=['web/src/styles.css'])
        self.assertEqual(gate.areas_needed(['web/src/styles.css'], reads), {'web', 'rust'})

    def test_the_real_tree_scans(self):
        # Only that the scan works here: which files it finds depends on every area's code,
        # and a web-only change mustn't be able to fail a Python test it doesn't run.
        reads = gate.cross_reads(ROOT)
        self.assertTrue(any('rust' in by for by in reads.values()))


class PushReuse(unittest.TestCase):
    REPO = 'o/r'
    RUN = {'path': '.github/workflows/ci.yml', 'event': 'pull_request',
           'head_repository': {'full_name': 'o/r'}}
    JOBS = [{'name': 'Local CI gate', 'conclusion': 'success'},
            {'name': 'Web checks', 'conclusion': 'success'},
            {'name': 'Rust tests', 'conclusion': 'success'},
            {'name': 'Python tests', 'conclusion': 'success'}]
    GREEN = {'id': 9, 'head_sha': 'g', 'conclusion': 'success', 'path': '.github/workflows/ci.yml',
             'head_repository': {'full_name': 'o/r'}, 'html_url': 'https://example.invalid/9'}
    RUNS = ('/repos/o/r/actions/workflows/ci.yml/runs?branch=main&event=push&status=success'
            f'&per_page={gate.GREEN_RUNS}')

    def test_a_pr_run_passes_the_areas_whose_jobs_succeeded(self):
        self.assertEqual(gate.passed_areas(self.RUN, self.JOBS, self.REPO), {'web', 'rust', 'python'})
        skipped = [dict(job, conclusion='skipped') if job['name'] == 'Rust tests' else job for job in self.JOBS]
        self.assertEqual(gate.passed_areas(self.RUN, skipped, self.REPO), {'web', 'python'})
        # Runs from before the Rust and Python jobs were split.
        old = [{'name': 'Web checks', 'conclusion': 'success'},
               {'name': 'Rust and Python tests', 'conclusion': 'success'}]
        self.assertEqual(gate.passed_areas(self.RUN, old, self.REPO), {'web', 'rust', 'python'})

    def test_other_runs_pass_nothing(self):
        for run in ({**self.RUN, 'event': 'push'}, {**self.RUN, 'path': '.github/workflows/other.yml'},
                    {**self.RUN, 'head_repository': {'full_name': 'fork/r'}}):
            with self.subTest(run=run):
                self.assertEqual(gate.passed_areas(run, self.JOBS, self.REPO), set())

    def push(self, files, extra=None, runs=None):
        responses = {
            self.RUNS: {'workflow_runs': runs if runs is not None else [self.GREEN]},
            '/repos/o/r/actions/runs/9/jobs?filter=latest&per_page=100': {'jobs': self.JOBS},
            f'/repos/o/r/compare/g...{TREE}': {'status': 'ahead', 'files': [{'filename': f} for f in files]},
            '/repos/o/r/git/commits/' + TREE: {'tree': {'sha': OTHER}},
            f'/repos/o/r/actions/artifacts?per_page=30&name=ci-passed-tree-{OTHER}': {'artifacts': []},
            **(extra or {})}
        calls = []

        def api(path):
            calls.append(path)
            return responses[path]

        scans = []

        def scan(gone):
            scans.append(sorted(gone))
            return {}

        original, gate.api = gate.api, api
        try:
            needed, reason = gate.decide_push('o/r', TREE, scan)
        finally:
            gate.api = original
        self.scans = scans
        return needed, reason, calls

    def test_push_needs_only_what_changed_since_the_last_green_main(self):
        needed, reason, _ = self.push(['web/src/App.tsx'])
        self.assertEqual(needed, {'web'})
        self.assertIn('`g`', reason)
        self.assertEqual(self.push(['docs/x.md'])[0], set())
        self.assertEqual(self.push(['server/src/main.rs', 'web/src/a.ts'])[0], {'web', 'rust', 'python'})

    def test_push_counts_deleted_and_renamed_away_paths(self):
        extra = {f'/repos/o/r/compare/g...{TREE}': {'status': 'ahead', 'files': [
            {'filename': 'docs/a.md', 'status': 'removed'},
            {'filename': 'docs/new.md', 'status': 'renamed', 'previous_filename': 'server/old.rs'},
            {'filename': 'docs/kept.md', 'status': 'modified'}]}}
        needed, _, _ = self.push([], extra)
        self.assertEqual(self.scans, [['docs/a.md', 'server/old.rs']])
        self.assertEqual(needed, {'rust', 'python'})  # the old path was the server's

    def test_push_reuses_only_the_jobs_a_pr_run_passed_on_the_same_tree(self):
        skipped_rust = [dict(job, conclusion='skipped') if job['name'] == 'Rust tests' else job
                        for job in self.JOBS]
        extra = {
            f'/repos/o/r/actions/artifacts?per_page=30&name=ci-passed-tree-{OTHER}': {'artifacts': [
                {'name': f'ci-passed-tree-{OTHER}', 'expired': True, 'workflow_run': {'id': 1}},
                {'name': f'ci-passed-tree-{OTHER}', 'expired': False, 'workflow_run': {'id': 2}},
                {'name': f'ci-passed-tree-{OTHER}', 'expired': False, 'workflow_run': {'id': 3}}]},
            '/repos/o/r/actions/runs/2': {**self.RUN, 'event': 'push'},
            '/repos/o/r/actions/runs/2/jobs?filter=latest&per_page=100': {'jobs': self.JOBS},
            '/repos/o/r/actions/runs/3': {**self.RUN, 'html_url': 'https://example.invalid/3'},
            '/repos/o/r/actions/runs/3/jobs?filter=latest&per_page=100': {'jobs': skipped_rust},
        }
        needed, reason, calls = self.push(['server/src/main.rs', 'web/src/a.ts'], extra)
        self.assertEqual(needed, {'rust'})
        self.assertIn('[3]', reason)
        self.assertNotIn('/repos/o/r/actions/runs/1', calls)

    def test_push_changing_a_cache_key_runs_without_looking_for_artifacts(self):
        needed, reason, calls = self.push(['deploy/phase-rev'])
        self.assertEqual(needed, {'rust', 'python'})
        self.assertIn('cache key', reason)
        self.assertFalse(any('artifacts' in call for call in calls))

    def test_tests_off_runs_and_unrelated_commits_are_no_base(self):
        off = {**self.GREEN, 'id': 7, 'head_sha': 'off'}
        diverged = {**self.GREEN, 'id': 8, 'head_sha': 'old'}
        extra = {
            '/repos/o/r/actions/runs/7/jobs?filter=latest&per_page=100': {'jobs': [
                {'name': gate.TESTS_OFF_JOB, 'conclusion': 'success'}]},
            '/repos/o/r/actions/runs/8/jobs?filter=latest&per_page=100': {'jobs': self.JOBS},
            f'/repos/o/r/compare/old...{TREE}': {'status': 'diverged'},
        }
        needed, _, calls = self.push(['web/src/a.ts'], extra, runs=[off, diverged, self.GREEN])
        self.assertEqual(needed, {'web'})
        self.assertNotIn(f'/repos/o/r/compare/off...{TREE}', calls)
        needed, reason, _ = self.push(['web/src/a.ts'], extra, runs=[off, diverged])
        self.assertEqual(needed, set(gate.AREAS))
        self.assertIn('No earlier main commit', reason)

    def test_unreadable_or_huge_push_runs_everything(self):
        self.assertEqual(self.push([])[0], set(gate.AREAS))
        self.assertEqual(self.push(['web/src/a.ts'] * 300)[0], set(gate.AREAS))


class CacheKeys(unittest.TestCase):
    def test_cache_key_changes_are_recognised(self):
        for path in ('Cargo.lock', 'play/Cargo.toml', 'deploy/phase-rev', 'package-lock.json',
                     'rust-toolchain.toml', '.github/workflows/ci.yml'):
            with self.subTest(path=path):
                self.assertTrue(gate.changes_cache_key(['web/src/a.ts', path]))
        self.assertFalse(gate.changes_cache_key(['server/src/main.rs', 'web/package.json']))


class Workflow(unittest.TestCase):
    workflow = (ROOT / '.github/workflows/ci.yml').read_text()

    def test_drafts_start_no_jobs_and_ready_runs(self):
        self.assertIn('types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]',
                      self.workflow)
        self.assertIn('!github.event.pull_request.draft', job(self.workflow, 'gate'))
        for name in ('web', 'rust', 'python'):
            self.assertIn('!github.event.pull_request.draft', job(self.workflow, name))

    def test_gate_only_runs_for_trusted_pull_requests(self):
        gate_job = job(self.workflow, 'gate')
        self.assertIn("github.event_name == 'pull_request' &&", gate_job)
        self.assertIn('github.event.pull_request.head.repo.full_name == github.repository', gate_job)
        self.assertNotIn('secrets.', gate_job)
        self.assertIn('sparse-checkout: |\n            scripts/ci/gate.py\n', gate_job)
        for pattern in ('*.rs', '*.py', '*.ts', '*.tsx', '*.mjs'):
            self.assertIn(f'\n            {pattern}\n', gate_job)
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
        # A failed or skipped gate (manual run) leaves no output, so every job runs.
        for name in ('web', 'rust', 'python'):
            with self.subTest(job=name):
                text = job(self.workflow, name)
                self.assertIn('needs: gate', text)
                self.assertIn(f'      {name}: ${{{{ steps.decide.outputs.{name} }}}}', job(self.workflow, 'gate'))
                condition = re.search(r'if: >-\n(.*?)\n    runs-on', text, re.S).group(1)
                self.assertRegex(condition, r"^\s*!cancelled\(\) &&\n"
                                            r"\s*\(vars\.CI_TESTS == 'on' \|\| github\.event_name == 'workflow_dispatch'\) &&\n"
                                            r"\s*needs\.gate\.outputs\.skip != 'true' &&\n"
                                            rf"\s*needs\.gate\.outputs\.{name} != 'false' &&\n"
                                            r"\s*\(github\.event_name != 'pull_request' \|\|")
                self.assertNotIn(f"outputs.{name} == 'true'", condition)
                self.assertNotIn("outputs.skip == 'false'", condition)
                self.assertIn('github.event.pull_request.head.repo.full_name == github.repository', condition)

    def test_tests_run_only_when_switched_on_or_started_by_hand(self):
        gate_if = re.search(r'if: >-\n(.*?)\n    # ', job(self.workflow, 'gate'), re.S).group(1)
        self.assertRegex(gate_if, r"^\s*vars\.CI_TESTS == 'on' &&\n")
        for name in ('web', 'rust', 'python'):
            with self.subTest(job=name):
                self.assertIn("(vars.CI_TESTS == 'on' || github.event_name == 'workflow_dispatch') &&",
                              job(self.workflow, name))
        android = (ROOT / '.github/workflows/android.yml').read_text()
        self.assertIn("if: vars.CI_TESTS == 'on' || github.event_name == 'workflow_dispatch'", android)

    def test_every_job_defaults_to_hosted_and_refuses_self_hosted_when_public(self):
        # The repository is public: a self-hosted runner must never take its jobs (AGENTS.md).
        for name in ('gate', 'tests-off', 'web', 'rust', 'python', 'passed'):
            with self.subTest(job=name):
                text = job(self.workflow, name)
                self.assertIn("runs-on: ${{ fromJSON(vars.CI_LINUX_RUNNER || '[\"ubuntu-latest\"]') }}", text)
                first = text.split('    steps:\n', 1)[1].split('\n      - ', 1)[0]
                self.assertIn('Refuse a self-hosted runner on a public repository', first)
                self.assertIn("runner.environment == 'self-hosted' && github.event.repository.private == false", first)
                # The step must actually stop the job.
                body = '\n'.join(line[10:] for line in first.split('        run: |\n', 1)[1].splitlines())
                run = subprocess.run(['bash', '-c', body], capture_output=True, text=True, timeout=5)
                self.assertNotEqual(run.returncode, 0, body)
                self.assertIn('::error::', run.stdout)
                # Hosted by default: an unset runner variable gets the hosted time limit, not saget's 360.
                self.assertIn("contains(vars.CI_LINUX_RUNNER || 'ubuntu-latest', 'self-hosted') && 360 ||", text)
        self.assertNotIn('self-hosted","Linux"', self.workflow)
        self.assertNotIn("|| 'self-hosted', 'self-hosted')", self.workflow)

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

    def test_the_passed_tree_is_published_only_when_every_job_passed_or_was_not_needed(self):
        passed = job(self.workflow, 'passed')
        self.assertIn('needs: [web, rust, python]', passed)
        condition = re.search(r'if: >-\n(.*?)\n    runs-on', passed, re.S).group(1)
        self.assertIn("!cancelled() && github.event_name == 'pull_request' &&", condition)
        for name in ('web', 'rust', 'python'):
            self.assertIn('contains(fromJSON(\'["success","skipped"]\'), needs.' + name + '.result)', condition)
        self.assertIn('name: ci-passed-tree-${{ steps.tested.outputs.tree }}', passed)
        self.assertIn('overwrite: true', passed)  # a re-run uploads the same name again
        for name in ('web', 'rust', 'python'):
            self.assertNotIn('upload-artifact', job(self.workflow, name))
        # The Python suites left the Rust job.
        self.assertNotIn('python3 deploy', job(self.workflow, 'rust'))
        self.assertIn('Test list validation with Python optimization', job(self.workflow, 'python'))

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
        self.assertIn('Rust tests: skipped, nothing changed since main needs them', result.stdout)
        self.assertIn('Python tests: skipped', result.stdout)
        calls = self.log.read_text()
        self.assertIn('npm test', calls)
        self.assertNotIn('cargo', calls)
        self.assertNotIn('python3 deploy/test_release.py', calls)

    def test_python_only_change_skips_web_and_rust(self):
        self.web_only_branch('deploy/notes.py')
        result = self.run_script('--no-amend')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Web checks: skipped', result.stdout)
        calls = self.log.read_text()
        self.assertNotIn('npm', calls)
        self.assertNotIn('cargo', calls)
        self.assertIn('python3 deploy/test_release.py', calls)

    def test_documentation_only_change_runs_nothing_but_full_runs_everything(self):
        self.web_only_branch('docs/notes.md')
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertNotIn('npm', self.log.read_text())
        self.assertNotIn('cargo', self.log.read_text())
        self.log.unlink()
        self.assertEqual(self.run_script('--no-amend', '--full').returncode, 0)
        for check in ('npm test', 'cargo test --locked', 'python3 deploy/test_release.py'):
            self.assertIn(check, self.log.read_text())

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

    def test_deleting_a_file_the_server_embeds_runs_rust(self):
        (self.repo / 'server').mkdir()
        (self.repo / 'server/page.rs').write_text('const N: &str = include_str!("../docs/notes.md");\n')
        (self.repo / 'docs').mkdir()
        (self.repo / 'docs/notes.md').write_text('notes\n')
        self.web_only_branch('docs/other.md')
        self.git(self.repo, 'rm', '-q', 'docs/notes.md')
        self.git(self.repo, 'commit', '-q', '-m', 'Delete the notes')
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertIn('cargo test --locked', self.log.read_text())

    def test_a_silent_detector_means_the_full_run(self):
        self.web_only_branch('docs/notes.md')
        self.stub('python3', 0)
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        for check in ('npm test', 'cargo test --locked', 'python3 deploy/test_release.py'):
            self.assertIn(check, self.log.read_text())

    def test_no_amend_leaves_head(self):
        head = self.git(self.repo, 'rev-parse', 'HEAD')
        self.assertEqual(self.run_script('--no-amend').returncode, 0)
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), head)


if __name__ == '__main__':
    unittest.main()
