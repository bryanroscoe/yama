"""Production release failure/authorization tests; no real GitHub, Docker or SSH."""
import importlib.util
import io
import json
import os
import re
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('host', Path(__file__).with_name('host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
SHA = 'a' * 40
OTHER = 'b' * 40


class HostGate(unittest.TestCase):
    def test_opaque_legacy_jwt_and_long_tokens_round_trip_without_format_assumptions(self):
        tokens = ('ghp_' + 'a' * 36,
                  'ghs_123_' + 'header.payload-with_url_safe-punctuation.signature',
                  'future-format:opaque/value+with=punctuation', 'long_' + 'a' * 2048)
        for token in tokens:
            for ending in ('\n', '\r\n', ''):
                with self.subTest(length=len(token), ending=repr(ending)):
                    self.assertEqual(host.read_token(io.StringIO(token + ending)), token)

    def test_empty_oversized_and_unsafe_transport_tokens_are_rejected_without_echoing(self):
        for token in ('', 'bad private token value', 'private\ttoken', 'private\x00token',
                      'private\x1btoken', 'private\u00e9token', 'a' * (host.MAX_TOKEN_LENGTH + 1)):
            with self.subTest(length=len(token)):
                with self.assertRaises(host.Refused) as error:
                    host.read_token(io.StringIO(token + '\n'))
                self.assertNotIn('private', str(error.exception))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='yama-host-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'release'
        self.base.mkdir()
        self.app = self.root / 'app'
        self.app.mkdir()
        for name in ('yama.env', 'advisor.env', 'forge.env'):
            (self.app / name).write_text('PRIVATE=never-log-this\n')
        (self.app / 'compose.yaml').write_text('old compose\n')
        (self.app / 'data').mkdir()
        for key, value in (('BASE', self.base), ('APP', self.app)):
            p = patch.object(host, key, value)
            p.start()
            self.addCleanup(p.stop)
        self.good_run = {'head_sha': SHA, 'head_branch': 'main', 'event': 'push',
                         'status': 'completed', 'conclusion': 'success',
                         'path': '.github/workflows/ci.yml',
                         'head_repository': {'full_name': host.REPO}}

    def responses(self, run=None, revision=SHA):
        return [{'object': {'sha': revision}}, {'workflow_runs': [run or self.good_run]}]

    def test_only_current_main_successful_push_ci_is_authorized(self):
        with patch.object(host, 'api', side_effect=self.responses()) as api:
            self.assertTrue(host.verify_ci(SHA, 'private-token'))
            self.assertIn('head_sha=' + SHA, api.call_args.args[0])
            self.assertIn('event=push', api.call_args.args[0])

    def test_manual_ci_cannot_cancel_deployable_push_ci(self):
        workflow = Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml'
        group = re.search(r'^  group: (.+)$', workflow.read_text(), re.M).group(1)

        def rendered(event, ref='refs/heads/main', pr=None, revision=SHA):
            context = {'github.workflow': 'CI', 'github.event_name': event, 'github.sha': revision,
                       'github.event.pull_request.number || github.ref': str(pr or ref)}
            return re.sub(r'\$\{\{\s*(.*?)\s*\}\}', lambda m: context[m[1]], group)

        # A later push still supersedes older push CI, but diagnostics and PRs
        # cannot cancel the push that the production host requires.
        push = rendered('push')
        self.assertNotEqual(push, rendered('workflow_dispatch'))
        self.assertNotEqual(push, rendered('pull_request', pr=23))
        self.assertEqual(push, rendered('push', revision=OTHER))
        self.assertEqual(rendered('pull_request', pr=23), rendered('pull_request', pr=23, revision=OTHER))
        self.assertNotEqual(rendered('pull_request', pr=23), rendered('pull_request', pr=24))

    def test_failed_running_pr_foreign_and_wrong_workflow_ci_are_refused(self):
        for change in ({'conclusion': 'failure'}, {'status': 'in_progress'},
                       {'event': 'pull_request'}, {'event': 'workflow_dispatch'}, {'head_branch': 'feature'},
                       {'head_sha': OTHER}, {'path': '.github/workflows/lab-worker.yml'},
                       {'head_repository': {'full_name': 'stranger/yama'}}):
            with self.subTest(change=change), patch.object(host, 'api', side_effect=self.responses({**self.good_run, **change})):
                with self.assertRaises(host.Refused):
                    host.verify_ci(SHA, 'token')

    def test_missing_ci_is_refused(self):
        with patch.object(host, 'api', side_effect=[{'object': {'sha': SHA}}, {'workflow_runs': []}]):
            with self.assertRaises(host.Refused):
                host.verify_ci(SHA, 'token')

    def test_superseded_request_never_checks_out_or_contacts_docker(self):
        with patch.object(host, 'api', return_value={'object': {'sha': OTHER}}), patch.object(host, 'run') as run:
            host.release(SHA, 'token')
            run.assert_not_called()

    def test_check_only_does_not_build_or_mutate_app(self):
        with patch.object(host, 'api', side_effect=self.responses()), patch.object(host, 'run') as run:
            host.release(SHA, 'token', check_only=True)
            run.assert_not_called()
        self.assertEqual((self.app / 'compose.yaml').read_text(), 'old compose\n')

    def test_forced_ssh_command_cannot_execute_arbitrary_shell_or_use_short_sha(self):
        command = host.ENTRYPOINT + ' deploy ' + SHA
        self.assertEqual(host.arguments([], command), ('deploy', SHA))
        for original in ('sh', command + '; id', command + ' extra',
                         host.ENTRYPOINT + ' deploy abc1234', host.ENTRYPOINT + ' check ' + SHA + '\nwhoami'):
            with self.subTest(original=original), self.assertRaises(host.Refused):
                host.arguments([], original)

    def test_api_failure_does_not_echo_credentials(self):
        with patch.object(host, 'urlopen', side_effect=host.URLError('private-token')):
            with self.assertRaises(host.Refused) as error:
                host.api('git/ref/heads/main', 'private-token')
        self.assertNotIn('private-token', str(error.exception))

    def test_archive_failure_stops_before_tar(self):
        with patch.object(host, 'run', side_effect=host.Refused('git failed')) as run:
            with self.assertRaises(host.Refused):
                host.export(self.root, SHA, self.root / 'source')
            self.assertEqual(run.call_count, 1)

    def test_compose_keeps_server_override_and_scopes_project(self):
        override = self.app / 'compose.override.yaml'
        override.write_text('local capacity\n')
        with patch.object(host, 'run', return_value='') as run:
            host.compose(self.root / 'candidate.yaml', {}, 'up', '-d', '--no-deps', *host.SERVICES)
        args = run.call_args.args[0]
        self.assertIn(override, args)
        self.assertIn('--no-deps', args)
        self.assertEqual(args[args.index('--project-name') + 1], 'yama')

    def resolved(self, images=None):
        services = {s: {'image': image} for s, image in zip(host.SERVICES, images or ['id'] * 3)}
        services['yama'].update(environment={}, volumes=[{
            'type': 'bind', 'source': str(self.app / 'data'), 'target': '/data'}])
        return json.dumps({'services': services})

    def test_backup_failure_prevents_config_replacement_and_restart(self):
        source = self.root / 'source'
        (source / 'deploy').mkdir(parents=True)
        (source / 'deploy/compose.yaml').write_text('candidate compose\n')
        with patch.object(host, 'compose', return_value=self.resolved()) as compose, \
             patch.object(host, 'existing_images', return_value={s: 'previous-id' for s in host.SERVICES}), \
             patch.object(host.os, 'chown'), patch.object(host, 'run', side_effect=host.Refused('backup failed')):
            with self.assertRaises(host.Refused):
                host.activate(source, SHA, ['id'] * 3, {}, self.base / 'record.json', 'token')
            self.assertEqual(compose.call_count, 1)  # config validation only
        self.assertEqual((self.app / 'compose.yaml').read_text(), 'old compose\n')
        self.assertFalse((self.base / 'previous.json').exists())

    def test_backup_must_actually_exist(self):
        source = self.root / 'source'
        (source / 'deploy').mkdir(parents=True)
        (source / 'deploy/compose.yaml').write_text('candidate compose\n')
        with patch.object(host, 'compose', return_value=self.resolved()) as compose, \
             patch.object(host, 'existing_images', return_value={s: 'old-id' for s in host.SERVICES}), \
             patch.object(host.os, 'chown'), patch.object(host, 'run', return_value=''):
            with self.assertRaisesRegex(host.Refused, 'did not produce'):
                host.activate(source, SHA, ['id'] * 3, {}, self.base / 'record.json', 'token')
            self.assertEqual(compose.call_count, 1)

    def test_healthy_container_from_wrong_image_cannot_pass(self):
        with patch.object(host, 'inspect', return_value={'Image': 'old-image', 'State': {
            'Running': True, 'Health': {'Status': 'healthy'}}}), patch.object(host, 'urlopen') as http:
            self.assertFalse(host.healthy(['candidate'] * 3))
            http.assert_not_called()

    def test_plain_text_health_is_checked_with_all_candidate_images(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b'ok'
        with patch.object(host, 'inspect', return_value={'Image': 'candidate', 'State': {
            'Running': True, 'Health': {'Status': 'healthy'}}}), patch.object(host, 'urlopen', return_value=response):
            self.assertTrue(host.healthy(['candidate'] * 3))
            response.read.return_value = b'{"ok":true}'
            self.assertFalse(host.healthy(['candidate'] * 3))

    def test_successful_activation_keeps_override_backup_and_exact_images(self):
        source = self.root / 'source'
        (source / 'deploy').mkdir(parents=True)
        (source / 'deploy/compose.yaml').write_text('candidate compose\n')
        override = self.app / 'compose.override.yaml'
        override.write_text('local capacity\n')
        calls = []
        def execute(args, **kwargs):
            calls.append(args)
            if args[:4] == ['docker', 'exec', 'yama', 'yama-server']:
                (self.app / 'data/backups' / Path(args[-1]).name).write_text('backup')
            return ''
        with patch.object(host, 'compose', return_value=self.resolved(['candidate-id'] * 3)) as compose, \
             patch.object(host, 'existing_images', return_value={s: 'old-id' for s in host.SERVICES}), \
             patch.object(host.os, 'chown'), patch.object(host, 'run', side_effect=execute), \
             patch.object(host, 'healthy', return_value=True), patch.object(host, 'verify_ci', return_value=True):
            record = {}
            host.activate(source, SHA, ['candidate-id'] * 3, record, self.base / 'record.json', 'token')
        self.assertEqual((self.app / 'compose.yaml').read_text(), 'candidate compose\n')
        self.assertEqual(override.read_text(), 'local capacity\n')
        self.assertTrue(Path(record['backup']).is_file())
        self.assertEqual(record['images'], {s: 'candidate-id' for s in host.SERVICES})
        self.assertEqual(json.loads((self.base / 'record.previous.json').read_text())['images'],
                         {s: 'old-id' for s in host.SERVICES})
        self.assertEqual(compose.call_args.args[2:], ('up', '-d', '--no-deps', '--pull', 'never', *host.SERVICES))
        self.assertEqual(calls[1:], [['docker', 'tag', s + ':' + SHA, s + ':latest'] for s in host.SERVICES])

    def test_supersession_after_build_preserves_running_service_and_cleans_exports(self):
        repo = self.root / 'repo'
        repo.mkdir()
        def export(repo, revision, destination, *paths):
            destination.mkdir()
        with patch.object(host, 'verify_ci', side_effect=[True, False]), \
             patch.object(host, 'checkout', return_value=repo), \
             patch.object(host, 'phase_checkout', return_value=(repo, OTHER)), \
             patch.object(host, 'export', side_effect=export), \
             patch.object(host, 'run', return_value='image-id'), patch.object(host, 'activate') as activate:
            host.release(SHA, 'token')
            activate.assert_not_called()
        self.assertEqual(list((self.base / 'builds').iterdir()), [])
        records = list((self.base / 'history').glob('*.json'))
        self.assertEqual(len(records), 1)
        self.assertEqual(json.loads(records[0].read_text())['status'], 'superseded')
        self.assertFalse((self.base / 'current.json').exists())

    def test_actions_timeout_covers_host_wait_and_release_with_cleanup_margin(self):
        workflow = Path(__file__).resolve().parents[1] / '.github/workflows/deploy.yml'
        minutes = int(re.search(r'timeout-minutes:\s*(\d+)', workflow.read_text()).group(1))
        self.assertGreater(minutes * 60, host.LOCK_WAIT_SECONDS + host.RELEASE_SECONDS + 300)

    def test_phase_preparation_failure_is_recorded_before_any_build(self):
        with patch.object(host, 'verify_ci', return_value=True), \
             patch.object(host, 'checkout', return_value=self.root), \
             patch.object(host, 'phase_checkout', side_effect=host.Refused('Phase fetch unavailable')), \
             patch.object(host, 'run') as run:
            with self.assertRaisesRegex(host.Refused, 'Phase fetch unavailable'):
                host.release(SHA, 'private-token')
            run.assert_not_called()
        records = list((self.base / 'history').glob('*.json'))
        self.assertEqual(len(records), 1)
        record = json.loads(records[0].read_text())
        self.assertEqual(record, {'revision': SHA, 'phase': None, 'status': 'failed',
                                 'stage': 'phase_checkout', 'error': 'Phase fetch unavailable'})
        self.assertNotIn('private-token', records[0].read_text())
        self.assertFalse((self.base / 'current.json').exists())

    def test_yama_fetch_failure_also_retains_attempt_provenance(self):
        with patch.object(host, 'verify_ci', return_value=True), \
             patch.object(host, 'checkout', side_effect=host.Refused('Yama fetch unavailable')):
            with self.assertRaises(host.Refused):
                host.release(SHA, 'token')
        record = json.loads(next((self.base / 'history').glob('*.json')).read_text())
        self.assertEqual(record['status'], 'failed')
        self.assertEqual(record['stage'], 'checkout')
        self.assertEqual(record['error'], 'Yama fetch unavailable')

    def activation_fixture(self):
        source = self.root / 'source'
        (source / 'deploy').mkdir(parents=True)
        (source / 'deploy/compose.yaml').write_text('candidate compose\n')
        return source

    def test_main_advancing_during_backup_prevents_config_switch_and_restart(self):
        source = self.activation_fixture()
        backup_created = []
        def backup(args, **kwargs):
            path = self.app / 'data/backups' / Path(args[-1]).name
            path.write_text('backup')
            backup_created.append(path)
            return ''
        def recheck(revision, token):
            self.assertEqual(revision, SHA)
            self.assertTrue(backup_created[0].is_file())
            return False
        with patch.object(host, 'compose', return_value=self.resolved()) as compose, \
             patch.object(host, 'existing_images', return_value={s: 'old' for s in host.SERVICES}), \
             patch.object(host.os, 'chown'), patch.object(host, 'run', side_effect=backup), \
             patch.object(host, 'verify_ci', side_effect=recheck):
            record = {}
            result = host.activate(source, SHA, ['id'] * 3, record, self.base / 'record.json', 'token')
            self.assertFalse(result)
            self.assertEqual(record['status'], 'superseded')
            self.assertEqual(compose.call_count, 1)
        self.assertEqual((self.app / 'compose.yaml').read_text(), 'old compose\n')
        self.assertFalse((self.base / 'previous.json').exists())
        self.assertEqual(list(self.app.glob('.compose.release-*')), [])

    def test_missing_container_with_existing_database_never_skips_backup(self):
        source = self.activation_fixture()
        (self.app / 'data/yama.db').write_text('existing data')
        with patch.object(host, 'compose', return_value=self.resolved()) as compose, \
             patch.object(host, 'existing_images', return_value={s: None for s in host.SERVICES}), \
             patch.object(host, 'run') as run:
            with self.assertRaisesRegex(host.Refused, 'Existing database requires'):
                host.activate(source, SHA, ['id'] * 3, {}, self.base / 'record.json', 'token')
            run.assert_not_called()
            self.assertEqual(compose.call_count, 1)
        self.assertEqual((self.app / 'data/yama.db').read_text(), 'existing data')

    def test_custom_database_or_nonstandard_mount_never_takes_fresh_install_path(self):
        source = self.activation_fixture()
        (self.app / 'data/custom.db').write_text('restored data')
        variants = [
            {'environment': {'DATABASE_URL': 'sqlite:///data/custom.db'}},
            {'environment': {'YAMA_DATA_DIR': '/custom-data'}},
            {'volumes': [{'type': 'bind', 'source': '/different/data', 'target': '/data'}]},
        ]
        for variant in variants:
            config = json.loads(self.resolved())
            config['services']['yama'].update(variant)
            with self.subTest(variant=variant), patch.object(host, 'compose', return_value=json.dumps(config)) as compose, \
                 patch.object(host, 'existing_images', return_value={s: None for s in host.SERVICES}), \
                 patch.object(host, 'run') as run:
                with self.assertRaisesRegex(host.Refused, 'Custom database settings'):
                    host.activate(source, SHA, ['id'] * 3, {}, self.base / 'record.json', 'token')
                run.assert_not_called()
                self.assertEqual(compose.call_count, 1)
        self.assertEqual((self.app / 'data/custom.db').read_text(), 'restored data')

    def test_first_install_with_no_database_can_start_without_backup(self):
        source = self.activation_fixture()
        (self.app / 'compose.yaml').unlink()
        with patch.object(host, 'compose', return_value=self.resolved()) as compose, \
             patch.object(host, 'existing_images', return_value={s: None for s in host.SERVICES}), \
             patch.object(host, 'run', return_value='') as run, \
             patch.object(host, 'verify_ci', return_value=True), patch.object(host, 'healthy', return_value=True):
            record = {}
            self.assertTrue(host.activate(source, SHA, ['id'] * 3, record, self.base / 'record.json', 'token'))
            self.assertTrue(record['fresh_install'])
            self.assertIsNone(record['backup'])
            self.assertEqual(run.call_count, 3)  # only successful latest tags
            self.assertEqual(compose.call_args.args[2:], ('up', '-d', '--no-deps', '--pull', 'never', *host.SERVICES))
        self.assertEqual((self.app / 'compose.yaml').read_text(), 'candidate compose\n')

    def test_existing_images_distinguishes_absence_from_daemon_failure(self):
        with patch.object(host, 'run', return_value='yama\n'), patch.object(host, 'inspect', return_value={'Image': 'running-id'}):
            self.assertEqual(host.existing_images(), {'yama': 'running-id', 'yama-advisor': None, 'yama-forge': None})
        with patch.object(host, 'run', side_effect=host.Refused('Docker unavailable')):
            with self.assertRaises(host.Refused):
                host.existing_images()

    def test_bootstrap_creates_missing_pairs_once_and_preserves_paid_credentials(self):
        (self.app / 'yama.env').write_text('YAMA_ADMIN_EMAILS=owner@example.invalid,friend@example.invalid\n')
        (self.app / 'advisor.env').write_text('CLAUDE_CODE_OAUTH_TOKEN=keep-this-token\nANTHROPIC_SHARED_API_KEY=keep-this-key\n')
        (self.app / 'forge.env').unlink()
        host.bootstrap_sidecars(self.app)
        first = {p.name: p.read_bytes() for p in self.app.glob('*.env')}
        host.bootstrap_sidecars(self.app)
        self.assertEqual(first, {p.name: p.read_bytes() for p in self.app.glob('*.env')})
        def values(name):
            return dict(line.split('=', 1) for line in (self.app / name).read_text().splitlines() if '=' in line)
        yama, advisor, forge = values('yama.env'), values('advisor.env'), values('forge.env')
        self.assertEqual(yama['YAMA_ADVISOR_SECRET'], advisor['ADVISOR_SECRET'])
        self.assertEqual(yama['YAMA_FORGE_SECRET'], forge['FORGE_SECRET'])
        self.assertEqual(yama['YAMA_ADVISOR_SUBSCRIPTION_EMAILS'], 'owner@example.invalid')
        self.assertEqual(advisor['CLAUDE_CODE_OAUTH_TOKEN'], 'keep-this-token')
        self.assertEqual(advisor['ANTHROPIC_SHARED_API_KEY'], 'keep-this-key')
        for p in self.app.glob('*.env'):
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def test_bootstrap_preserves_exported_encryption_key_and_shared_credentials(self):
        (self.app / 'yama.env').write_text(
            'export YAMA_ADVISOR_KEY_SECRET=existing-encryption-key\n'
            'export YAMA_ADVISOR_SECRET=existing-advisor-secret\n'
            'export YAMA_FORGE_SECRET=existing-forge-secret\n')
        (self.app / 'advisor.env').write_text('export ADVISOR_SECRET=existing-advisor-secret\n')
        (self.app / 'forge.env').write_text('export FORGE_SECRET=existing-forge-secret\n')
        host.bootstrap_sidecars(self.app)
        yama = (self.app / 'yama.env').read_text()
        for key, value in (('YAMA_ADVISOR_KEY_SECRET', 'existing-encryption-key'),
                           ('YAMA_ADVISOR_SECRET', 'existing-advisor-secret'),
                           ('YAMA_FORGE_SECRET', 'existing-forge-secret')):
            self.assertIn('export ' + key + '=' + value + '\n', yama)
            self.assertEqual(sum(line.startswith(key + '=') for line in yama.splitlines()), 0)
        self.assertEqual((self.app / 'advisor.env').read_text(), 'export ADVISOR_SECRET=existing-advisor-secret\n')
        self.assertEqual((self.app / 'forge.env').read_text(), 'export FORGE_SECRET=existing-forge-secret\n')

    def test_bootstrap_recovers_a_missing_partner_without_rotating_secrets(self):
        (self.app / 'advisor.env').write_text('ADVISOR_SECRET=existing-advisor-secret\n')
        (self.app / 'yama.env').write_text('YAMA_FORGE_SECRET=existing-forge-secret\nYAMA_ADVISOR_KEY_SECRET=existing-encryption-key\n')
        host.bootstrap_sidecars(self.app)
        yama = (self.app / 'yama.env').read_text()
        self.assertIn('YAMA_ADVISOR_SECRET=existing-advisor-secret\n', yama)
        self.assertIn('YAMA_ADVISOR_KEY_SECRET=existing-encryption-key\n', yama)
        self.assertIn('FORGE_SECRET=existing-forge-secret\n', (self.app / 'forge.env').read_text())

    def test_bootstrap_conflicting_second_pair_fails_before_writing_any_file_or_secret(self):
        (self.app / 'forge.env').write_text('FORGE_SECRET=first-private-secret\n')
        (self.app / 'yama.env').write_text('YAMA_FORGE_SECRET=second-private-secret\n')
        before = {p.name: p.read_bytes() for p in self.app.glob('*.env')}
        with self.assertRaises(host.Refused) as error:
            host.bootstrap_sidecars(self.app)
        self.assertNotIn('first-private-secret', str(error.exception))
        self.assertNotIn('second-private-secret', str(error.exception))
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.app.glob('*.env')})

    def test_host_command_timeout_terminates_its_own_child(self):
        with self.assertRaisesRegex(host.Refused, 'timed out'):
            host.run([sys.executable, '-c', 'import time; time.sleep(60)'], timeout=0.05)

    def test_same_healthy_release_is_idempotent(self):
        (self.base / 'current.json').write_text(json.dumps({
            'revision': SHA, 'images': {s: 'id' for s in host.SERVICES}}))
        with patch.object(host, 'verify_ci', return_value=True), \
             patch.object(host, 'healthy', return_value=True), patch.object(host, 'checkout') as checkout:
            host.release(SHA, 'token')
            checkout.assert_not_called()

    def test_dedicated_checkout_initializes_fast_forwards_and_preserves_dirty_work(self):
        remote = self.root / 'remote.git'
        writer = self.root / 'writer'
        def git(*args, cwd=None):
            return subprocess.check_output(['git', '-c', 'commit.gpgsign=false', *map(str, args)],
                cwd=cwd, stderr=subprocess.DEVNULL, text=True).strip()
        git('init', '--bare', '--initial-branch=main', remote)
        git('init', '--initial-branch=main', writer)
        git('config', 'user.name', 'Test', cwd=writer)
        git('config', 'user.email', 'test@example.invalid', cwd=writer)
        (writer / 'file').write_text('first')
        git('add', '.', cwd=writer); git('commit', '-m', 'first', cwd=writer)
        git('push', str(remote), 'main', cwd=writer)
        first = git('rev-parse', 'HEAD', cwd=writer)
        env = dict(os.environ, GIT_CONFIG_COUNT='1',
                   GIT_CONFIG_KEY_0='url.' + str(remote) + '.insteadOf',
                   GIT_CONFIG_VALUE_0='https://github.com/' + host.REPO + '.git')
        with patch.object(host, 'git_auth', return_value=env):
            repo = host.checkout(first, 'token')
            self.assertEqual(git('rev-parse', 'HEAD', cwd=repo), first)
            (writer / 'file').write_text('second')
            git('add', '.', cwd=writer); git('commit', '-m', 'second', cwd=writer)
            git('push', str(remote), 'main', cwd=writer)
            second = git('rev-parse', 'HEAD', cwd=writer)
            self.assertIsNone(host.checkout(first, 'token'))
            self.assertEqual(git('rev-parse', 'HEAD', cwd=repo), first)
            host.checkout(second, 'token')
            self.assertEqual(git('rev-parse', 'HEAD', cwd=repo), second)
            (repo / 'file').write_text('preserve me')
            with self.assertRaisesRegex(host.Refused, 'clean main'):
                host.checkout(second, 'token')
            self.assertEqual((repo / 'file').read_text(), 'preserve me')

    def test_engine_pin_is_published_on_main_or_an_archive_tag_only(self):
        remote = self.root / 'phase.git'
        writer = self.root / 'phase-writer'
        repo = self.root / 'yama-checkout'
        (repo / 'deploy').mkdir(parents=True)
        (repo / 'deploy/phase-repo').write_text('https://github.com/bryanroscoe/yama-phase.git\n')
        def git(*args, cwd=writer):
            return subprocess.check_output(['git', '-c', 'commit.gpgsign=false', *map(str, args)],
                cwd=cwd, stderr=subprocess.DEVNULL, text=True).strip()
        git('init', '--bare', '--initial-branch=main', remote, cwd=self.root)
        git('init', '--initial-branch=main', writer, cwd=self.root)
        git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
        def commit(message):
            (writer / 'file').write_text(message)
            git('add', '.'); git('commit', '-m', message)
            return git('rev-parse', 'HEAD')
        archived = commit('engine before the rebase')
        git('tag', 'archive/pre-sync-test'); git('tag', 'preview-test', commit('other tag'))
        git('checkout', '--orphan', 'rebuilt'); on_main = commit('rebuilt main')
        git('push', remote, 'rebuilt:main', 'refs/tags/archive/pre-sync-test', 'refs/tags/preview-test')
        unpublished = commit('never pushed')
        env = dict(os.environ, GIT_CONFIG_COUNT='1',
                   GIT_CONFIG_KEY_0='url.' + str(remote) + '.insteadOf',
                   GIT_CONFIG_VALUE_0='git@github.com:bryanroscoe/yama-phase.git')
        with patch.dict(os.environ, env):
            for revision in (on_main, archived):
                (repo / 'deploy/phase-rev').write_text(revision + '\n')
                self.assertEqual(host.phase_checkout(repo), (self.base / 'yama-phase', revision))
            git('fetch', writer, 'HEAD', cwd=self.base / 'yama-phase')
            for revision in (unpublished, git('rev-parse', 'preview-test')):
                (repo / 'deploy/phase-rev').write_text(revision + '\n')
                with self.assertRaisesRegex(host.Refused, 'not on the engine repository'):
                    host.phase_checkout(repo)

    def test_lock_cannot_be_acquired_by_another_process_until_release(self):
        script = 'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'
        with host.release_lock():
            result = subprocess.run(['python3', '-c', script, str(self.base / 'release.lock')], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(['python3', '-c', script, str(self.base / 'release.lock')], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
