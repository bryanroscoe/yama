"""Production release failure/authorization tests; no real GitHub, Docker or SSH."""
import importlib.util
import io
import json
import os
import re
import select
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
        for key, value in (('BASE', self.base), ('APP', self.app), ('CI_ROOT', self.root / 'ci')):
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

    def test_moved_main_still_deploys_until_a_newer_main_commit_passes(self):
        pending = {**self.good_run, 'head_sha': OTHER, 'status': 'in_progress', 'conclusion': None}
        # Main moved to OTHER, whose CI is still running: SHA (on main, CI passed) deploys.
        with patch.object(host, 'api', side_effect=[{'object': {'sha': OTHER}}, {'status': 'ahead'},
                                                    {'workflow_runs': [pending]}, {'workflow_runs': [self.good_run]}]):
            self.assertTrue(host.verify_ci(SHA, 'token'))
        # OTHER's CI passed: its own request deploys it, so SHA's is superseded.
        done = {**self.good_run, 'head_sha': OTHER}
        with patch.object(host, 'api', side_effect=[{'object': {'sha': OTHER}}, {'status': 'ahead'},
                                                    {'workflow_runs': [done]}]):
            self.assertFalse(host.verify_ci(SHA, 'token'))
        # A commit that isn't on main never deploys.
        for status in ('diverged', 'behind', 'identical'):
            with self.subTest(status=status), patch.object(host, 'api', side_effect=[{'object': {'sha': OTHER}}, {'status': status}]):
                self.assertFalse(host.verify_ci(SHA, 'token'))

    def test_checkout_failures_are_errors_not_supersessions(self):
        repo = self.base / 'yama'
        repo.mkdir()
        def fake(args, **_):
            if 'merge-base' in args:
                raise host.Refused('Host command timed out: git')
            if 'get-url' in args:
                return 'https://github.com/' + host.REPO + '.git'
            return 'main' if 'symbolic-ref' in args else ''
        with patch.object(host, 'run', side_effect=fake), patch.object(host, 'git_auth', return_value={}):
            with self.assertRaisesRegex(host.Refused, 'timed out'):
                host.checkout(SHA, 'token')

    def test_production_never_goes_back_to_an_older_main_commit(self):
        (self.base / 'current.json').write_text(json.dumps({
            'revision': OTHER, 'images': {s: 'id' for s in host.SERVICES}}))
        with patch.object(host, 'verify_ci', return_value=True), \
             patch.object(host, 'api', return_value={'status': 'behind'}) as api, \
             patch.object(host, 'checkout') as checkout:
            self.assertEqual(host.release(SHA, 'token'), 'superseded')
            self.assertIn('compare/' + OTHER + '...' + SHA, api.call_args.args[0])
            checkout.assert_not_called()

    def test_missing_ci_is_refused(self):
        with patch.object(host, 'api', side_effect=[{'object': {'sha': SHA}}, {'workflow_runs': []}]):
            with self.assertRaises(host.Refused):
                host.verify_ci(SHA, 'token')

    def test_superseded_request_never_checks_out_or_contacts_docker(self):
        with patch.object(host, 'api', return_value={'object': {'sha': OTHER}}), \
             patch.object(host, 'release_lock') as lock, patch.object(host, 'run') as run:
            self.assertEqual(host.release(SHA, 'token'), 'superseded')
            run.assert_not_called()
            lock.assert_not_called()

    def test_unready_ci_never_reserves_priority_or_blocks_its_own_tests(self):
        with patch.object(host, 'verify_ci', side_effect=host.Refused('CI is pending')), \
             patch.object(host, 'release_lock') as lock:
            with self.assertRaisesRegex(host.Refused, 'CI is pending'):
                host.release(SHA, 'token')
            lock.assert_not_called()

    def test_main_is_rechecked_after_waiting_for_priority(self):
        with patch.object(host, 'verify_ci', side_effect=[True, False]) as verify, \
             patch.object(host, 'checkout') as checkout:
            self.assertEqual(host.release(SHA, 'token'), 'superseded')
            self.assertEqual(verify.call_count, 2)
            checkout.assert_not_called()

    def test_check_only_does_not_build_or_mutate_app(self):
        with patch.object(host, 'api', side_effect=self.responses()), \
             patch.object(host, 'release_lock') as lock, patch.object(host, 'run') as run:
            self.assertEqual(host.release(SHA, 'token', check_only=True), 'ready')
            run.assert_not_called()
            lock.assert_not_called()
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
            'Running': True, 'Health': {'Status': 'healthy'}}, 'NetworkSettings': {'Ports': {
            '8787/tcp': [{'HostIp': '192.0.2.40', 'HostPort': '8099'}]}}}), \
                patch.object(host, 'urlopen', return_value=response) as http:
            self.assertTrue(host.healthy(['candidate'] * 3))
            self.assertEqual(http.call_args.args[0], 'http://192.0.2.40:8099/api/health')
            response.read.return_value = b'{"ok":true}'
            self.assertFalse(host.healthy(['candidate'] * 3))

    def test_health_url_follows_the_published_port(self):
        def container(*bindings):
            return {'NetworkSettings': {'Ports': {'8787/tcp': list(bindings)}}}
        self.assertEqual(host.health_url(container({'HostIp': '0.0.0.0', 'HostPort': '8099'})),
                         'http://127.0.0.1:8099/api/health')
        self.assertEqual(host.health_url(container({'HostIp': '::', 'HostPort': '8099'},
                                                   {'HostIp': '192.0.2.40', 'HostPort': '8100'})),
                         'http://192.0.2.40:8100/api/health')
        self.assertIsNone(host.health_url(container()))
        self.assertIsNone(host.health_url({'NetworkSettings': {'Ports': {'8787/tcp': None}}}))
        self.assertIsNone(host.health_url({}))
        # An unpublished yama container cannot pass health.
        with patch.object(host, 'inspect', return_value={'Image': 'candidate', 'State': {
            'Running': True, 'Health': {'Status': 'healthy'}}}), patch.object(host, 'urlopen') as http:
            self.assertFalse(host.healthy(['candidate'] * 3))
            http.assert_not_called()

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
        with patch.object(host, 'verify_ci', side_effect=[True, True, False]), \
             patch.object(host, 'checkout', return_value=repo), \
             patch.object(host, 'phase_checkout', return_value=(repo, OTHER)), \
             patch.object(host, 'export', side_effect=export), \
             patch.object(host, 'run', return_value='image-id'), patch.object(host, 'activate') as activate:
            self.assertEqual(host.release(SHA, 'token'), 'superseded')
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
            # Main moved on: the older commit is still on main, so it stays deployable.
            self.assertEqual(host.checkout(first, 'token'), repo)
            self.assertEqual(git('rev-parse', 'HEAD', cwd=repo), first)
            host.checkout(second, 'token')
            self.assertEqual(git('rev-parse', 'HEAD', cwd=repo), second)
            # Never back to an older commit than the checkout has, and never off main.
            self.assertIsNone(host.checkout(first, 'token'))
            self.assertEqual(git('rev-parse', 'HEAD', cwd=repo), second)
            git('checkout', '-b', 'side', first, cwd=writer)
            (writer / 'side').write_text('off main')
            git('add', '.', cwd=writer); git('commit', '-m', 'side', cwd=writer)
            git('push', str(remote), 'side', cwd=writer)
            self.assertIsNone(host.checkout(git('rev-parse', 'HEAD', cwd=writer), 'token'))
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
        git('tag', '-a', '-m', 'archive', 'archive/pre-sync-test'); git('tag', 'preview-test', commit('other tag'))
        withdrawn = commit('archived then withdrawn')
        git('tag', 'archive/withdrawn-test')
        git('checkout', '--orphan', 'rebuilt'); on_main = commit('rebuilt main')
        git('push', remote, 'rebuilt:main', 'refs/tags/archive/pre-sync-test', 'refs/tags/preview-test',
            'refs/tags/archive/withdrawn-test')
        unpublished = commit('never pushed')
        env = dict(os.environ, GIT_CONFIG_COUNT='1',
                   GIT_CONFIG_KEY_0='url.' + str(remote) + '.insteadOf',
                   GIT_CONFIG_VALUE_0='git@github.com:bryanroscoe/yama-phase.git')
        with patch.dict(os.environ, env):
            for revision in (on_main, archived, withdrawn):
                (repo / 'deploy/phase-rev').write_text(revision + '\n')
                self.assertEqual(host.phase_checkout(repo), (self.base / 'yama-phase', revision))
            # Deleting a tag withdraws what only it published.
            git('push', remote, ':refs/tags/archive/withdrawn-test')
            with self.assertRaisesRegex(host.Refused, 'not on the engine repository'):
                host.phase_checkout(repo)
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

    def test_missing_fleet_admission_lock_fails_without_creating_another_inode(self):
        host.CI_ROOT.mkdir()
        with self.assertRaises(FileNotFoundError), host.release_lock():
            self.fail('Missing fleet lock was accepted')
        self.assertFalse((host.CI_ROOT / 'slots/admission.lock').exists())
        self.assertFalse((self.base / 'release.lock').exists())

    def test_pending_release_drains_existing_ci_and_excludes_new_ci_until_exit(self):
        # Real processes and kernel locks, on temporary paths only. This follows
        # the fleet protocol: release SH, admission EX nonblocking, release all
        # partial acquisitions if admission is denied.
        pool = host.CI_ROOT / 'slots'
        pool.mkdir(parents=True)
        admission_path = pool / 'admission.lock'
        admission_path.touch()
        release_path = self.base / 'release.lock'
        ci_probe = '''import fcntl,sys
with open(sys.argv[1], 'r') as release, open(sys.argv[2], 'r') as admission:
    fcntl.flock(release, fcntl.LOCK_SH | fcntl.LOCK_NB)
    fcntl.flock(admission, fcntl.LOCK_EX | fcntl.LOCK_NB)
'''
        pending = '''import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('host',sys.argv[1])
host=importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
host.BASE=Path(sys.argv[2]); host.CI_ROOT=Path(sys.argv[3])
host.LOCK_WAIT_SECONDS=10
with host.release_lock():
    print('ENTERED',flush=True)
    sys.stdin.readline()
'''
        def probe():
            return subprocess.run([sys.executable, '-c', ci_probe, str(release_path), str(admission_path)],
                                  capture_output=True, timeout=5)
        with release_path.open('a') as admitted:
            host.fcntl.flock(admitted, host.fcntl.LOCK_SH)
            child = subprocess.Popen([sys.executable, '-u', '-c', pending,
                str(Path(host.__file__)), str(self.base), str(host.CI_ROOT)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            def line():
                self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'Release fixture stalled')
                return child.stdout.readline().decode().strip()
            try:
                self.assertIn('reserve production priority', line())
                self.assertIn('Production priority reserved', line())
                self.assertIn('production release lock', line())
                self.assertNotEqual(probe().returncode, 0)
                host.fcntl.flock(admitted, host.fcntl.LOCK_UN)
                self.assertEqual(line(), 'ENTERED')
                self.assertNotEqual(probe().returncode, 0)
                child.stdin.write(b'finish\n')
                _, errors = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, errors)
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate()
        self.assertEqual(probe().returncode, 0)

    def test_lock_timeout_releases_priority_for_ci(self):
        pool = host.CI_ROOT / 'slots'
        pool.mkdir(parents=True)
        (pool / 'admission.lock').touch()
        with (self.base / 'release.lock').open('a') as ci:
            host.fcntl.flock(ci, host.fcntl.LOCK_SH)
            with patch.object(host, 'LOCK_WAIT_SECONDS', 0):
                with self.assertRaisesRegex(host.Refused, 'Timed out'), host.release_lock():
                    self.fail('Release unexpectedly entered')
        with (pool / 'admission.lock').open('r') as lock:
            host.fcntl.flock(lock, host.fcntl.LOCK_EX | host.fcntl.LOCK_NB)

    def workflow_deploy_scripts(self):
        """The release step of each deploy backend: the saget runner, then Cloudflare Access."""
        workflow = Path(__file__).resolve().parents[1] / '.github/workflows/deploy.yml'
        scripts = []
        for step in workflow.read_text().split('      - name: Deploy the successful main revision\n')[1:]:
            lines = []
            for line in step.split('        run: |\n', 1)[1].splitlines():
                if line and not line.startswith(' ' * 10):
                    break
                lines.append(line[10:])
            scripts.append('\n'.join(lines))
        self.assertEqual(len(scripts), 2)
        return scripts

    def run_workflow_script(self, script, **values):
        binary = self.root / 'bin'
        binary.mkdir(exist_ok=True)
        ssh = binary / 'ssh'
        ssh.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_SSH_ARGS"\n'
                       'printf "%s\\n" "${TUNNEL_SERVICE_TOKEN_ID:-}" "${TUNNEL_SERVICE_TOKEN_SECRET:-}" > "$FAKE_SSH_ARGS.token"\n'
                       'for a in "$@"; do case "$a" in */id_ed25519) cp "$a" "$FAKE_SSH_ARGS.key" ;; esac; done\n'
                       'cat >/dev/null\nprintf "%s\\n" "$FAKE_HOST_RESULT"\nexit "$FAKE_SSH_EXIT"\n')
        ssh.chmod(0o755)
        summary = self.root / 'summary'
        summary.write_text('')
        arguments = self.root / 'ssh-args'
        arguments.unlink(missing_ok=True)
        env = dict(os.environ, FAKE_SSH=str(ssh), FAKE_SSH_ARGS=str(arguments),
                   GH_TOKEN='private-fixture-token', RELEASE_SHA=SHA, DEPLOY_BACKEND='',
                   DEPLOY_SSH_HOST='192.0.2.40', DEPLOY_SSH_KEY='private-fixture-key',
                   DEPLOY_KNOWN_HOSTS='192.0.2.40 ssh-ed25519 AAAAfixture',
                   CF_ACCESS_CLIENT_ID='fixture-access-id', CF_ACCESS_CLIENT_SECRET='private-fixture-access-secret',
                   GITHUB_STEP_SUMMARY=str(summary), FAKE_HOST_RESULT='', FAKE_SSH_EXIT='0')
        env.update(values)
        # The fixture must never contact a real host, including inside a CI image.
        env.pop('BASH_ENV', None)
        env.pop('ENV', None)
        script = 'ssh() { /bin/sh "$FAKE_SSH" "$@"; }\n' + script
        run = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=5)
        args = arguments.read_text().splitlines() if arguments.exists() else None
        return run, summary.read_text(), args

    def test_workflow_reports_real_outcome_and_propagates_ssh_failure(self):
        for backend, script in zip(('runner', 'cloudflare'), self.workflow_deploy_scripts()):
            for result, exit_code, expected in (
                ('success', 0, 'Deployed and health-verified'),
                ('already_healthy', 0, 'nothing restarted'),
                ('superseded', 0, 'did not activate production'),
                ('unknown', 0, None), ('', 0, None), ('success', 23, None),
            ):
                with self.subTest(backend=backend, result=result, ssh_exit=exit_code):
                    run, summary, args = self.run_workflow_script(
                        script, FAKE_HOST_RESULT='YAMA_RELEASE_RESULT=' + result, FAKE_SSH_EXIT=str(exit_code))
                    self.assertEqual(run.returncode == 0, expected is not None, run.stdout + run.stderr)
                    if expected:
                        self.assertIn(expected, summary)
                    else:
                        self.assertEqual(summary, '')
                    self.assertNotIn('private-fixture', run.stdout + run.stderr)
                    self.assertIn('root@192.0.2.40', args)
                    self.assertIn('StrictHostKeyChecking=yes', args)
                    self.assertEqual(args[-1], '/mnt/user/appdata/yama-release/host.py deploy ' + SHA)
                    self.assertNotIn('private-fixture-token', '\n'.join(args))

    def test_cloudflare_workflow_uses_access_proxy_and_removes_its_key(self):
        _, script = self.workflow_deploy_scripts()
        run, _, args = self.run_workflow_script(script, FAKE_HOST_RESULT='YAMA_RELEASE_RESULT=success')
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        joined = '\n'.join(args)
        self.assertIn('ProxyCommand=cloudflared access ssh --hostname %h', args)
        self.assertIn('ServerAliveInterval=30', args)
        self.assertNotIn('private-fixture-access-secret', joined)
        # The proxy gets the Access service token from its environment, never its arguments.
        self.assertEqual((self.root / 'ssh-args.token').read_text(),
                         'fixture-access-id\nprivate-fixture-access-secret\n')
        key = Path(args[args.index('-i') + 1])
        self.assertEqual((self.root / 'ssh-args.key').read_text(), 'private-fixture-key\n')
        self.assertFalse(key.exists(), 'the deploy key outlives the step')
        self.assertFalse(key.parent.exists())
        for missing in ('DEPLOY_SSH_HOST', 'DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS',
                        'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'):
            with self.subTest(missing=missing):
                run, summary, args = self.run_workflow_script(script, **{missing: ''})
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(missing, run.stdout)
                self.assertIsNone(args, 'ssh ran without its configuration')

    def test_workflow_backends_share_guards_and_exclude_each_other(self):
        text = (Path(__file__).resolve().parents[1] / '.github/workflows/deploy.yml').read_text()
        guards = re.findall(r"^    if: >-\n((?:      .*\n)+)", text, re.M)
        self.assertEqual(len(guards), 2)
        runner, cloudflare = (' '.join(line.strip() for line in guard.splitlines()) for guard in guards)
        self.assertTrue(runner.startswith("vars.DEPLOY_BACKEND != 'cloudflare' && "), runner)
        self.assertTrue(cloudflare.startswith("vars.DEPLOY_BACKEND == 'cloudflare' && "), cloudflare)
        shared = "github.ref == 'refs/heads/main' &&"
        self.assertEqual(runner.split(' && ', 1)[1], cloudflare.split(' && ', 1)[1])
        self.assertIn(shared, runner)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", runner)

    def test_runner_workflow_refuses_unknown_backend_or_host(self):
        script, _ = self.workflow_deploy_scripts()
        for values in ({'DEPLOY_BACKEND': 'clodflare'}, {'DEPLOY_SSH_HOST': ''},
                       {'DEPLOY_SSH_HOST': '-oProxyCommand=x'}):
            with self.subTest(**values):
                run, summary, args = self.run_workflow_script(
                    script, FAKE_HOST_RESULT='YAMA_RELEASE_RESULT=success', **values)
                self.assertNotEqual(run.returncode, 0)
                self.assertIsNone(args)
                self.assertEqual(summary, '')

    def test_entrypoint_emits_outcome_only_after_completed_request(self):
        for outcome in ('success', 'already_healthy', 'superseded', 'ready'):
            with self.subTest(outcome=outcome), patch.object(host.signal, 'signal'), \
                 patch.object(host, 'arguments', return_value=('deploy', SHA)), \
                 patch.object(host, 'read_token', return_value='private-fixture-token'), \
                 patch.object(host, 'release', return_value=outcome), patch.object(host, 'log') as log:
                self.assertEqual(host.main(), 0)
                log.assert_called_once_with('YAMA_RELEASE_RESULT=' + outcome)
        with patch.object(host.signal, 'signal'), \
             patch.object(host, 'arguments', return_value=('deploy', SHA)), \
             patch.object(host, 'read_token', return_value='private-fixture-token'), \
             patch.object(host, 'release', side_effect=host.Refused('CI pending')), patch.object(host, 'log') as log:
            self.assertEqual(host.main(), 1)
            log.assert_called_once_with('Release refused: CI pending')


if __name__ == '__main__':
    unittest.main(verbosity=2)
