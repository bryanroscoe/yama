"""Exercise the real frozen worker; source-only CI explicitly skips these tests."""
import contextlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import unittest

HERE = Path(__file__).resolve().parent


@unittest.skipUnless(os.environ.get('YAMA_HISTORICAL_RUNTIME') and os.environ.get('YAMA_HISTORICAL_CARD_DATA'),
                     'requires the built, bound historical runtime and real pinned data')
class HistoricalControls(unittest.TestCase):
    recipe = HERE
    binary_env = 'YAMA_HISTORICAL_RUNTIME'
    data_env = 'YAMA_HISTORICAL_CARD_DATA'

    @classmethod
    def setUpClass(cls):
        cls.binary = os.environ[cls.binary_env]
        cls.data = os.environ[cls.data_env]
        cls.manifest = json.loads((cls.recipe/'historical.json').read_text())
        result = subprocess.run([cls.binary, '--fixture', cls.data], env={},
                                capture_output=True, text=True, timeout=90, check=True)
        cls.fixture = json.loads(result.stdout)

    @contextlib.contextmanager
    def worker(self):
        process = subprocess.Popen([self.binary], env={}, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)

        def read():
            self.assertTrue(selector.select(90), 'worker response timed out')
            line = process.stdout.readline()
            self.assertTrue(line, 'worker exited before responding')
            value = json.loads(line)
            self.assertNotIn('error', value, value)
            return value

        def call(value):
            process.stdin.write(json.dumps(dict(session='test', **value))+'\n')
            process.stdin.flush()
            return read()

        try:
            greeting = read()
            self.assertEqual(greeting['hello'], self.manifest)
            self.assertEqual(greeting['source'], json.loads((self.recipe/'historical-source.json').read_text()))
            yield call
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            selector.close()
            process.stdout.close()
            process.stderr.close()

    def opened(self, call, replay):
        return call(dict(op='open', identity=self.manifest['identity'], data=self.data,
                         replay=replay, log=None, answers=None, ai=[[1, 'Easy']],
                         humans=[0], names=['Ana', 'Ben']))['state']

    @staticmethod
    def controls(state):
        return json.loads(state['replay'])['yama_historical_controls_v1'][0][1]

    @staticmethod
    def account(call, full=False, stops=None, tap='ask'):
        return call(dict(op='command', type='account_prefs', seat=0,
                         full_control=full, stops=stops, tap_mana=tap))['state']

    def test_legacy_full_control_survives_account_defaults_and_reconnect(self):
        with self.worker() as call:
            opened = self.opened(call, self.fixture['legacy_full_replay'])
            actions = json.loads(opened['replay'])['actions']
            state = self.account(call)
            self.assertTrue(self.controls(state)['full_control'])
            self.assertEqual(json.loads(state['replay'])['actions'], actions)
            self.assertEqual(state['revision'], opened['revision'])
            state = self.account(call, stops={'own': ['Upkeep'], 'others': []}, tap='manual')
            self.assertTrue(self.controls(state)['full_control'])
            self.assertEqual(self.controls(state), self.controls(opened))
            view = call(dict(op='view', viewer=0))['view']
            self.assertTrue(view['turns']['full_control'])

    def test_sidecar_preserves_stops_payment_and_temporary_hold(self):
        for name in ('full', 'hold'):
            with self.subTest(name=name), self.worker() as call:
                opened = self.opened(call, self.fixture[name]['replay'])
                state = self.account(call, full=(name == 'hold'))
                self.assertEqual(self.controls(state), self.controls(self.fixture[name]))
                self.assertEqual(state['revision'], opened['revision'])
                self.assertEqual(json.loads(state['replay'])['actions'], json.loads(opened['replay'])['actions'])
                if name == 'hold':
                    self.assertTrue(self.controls(state)['hold'])
                    self.assertFalse(self.controls(state)['full_control'])

    def test_explicit_changes_survive_later_defaults_and_another_process(self):
        with self.worker() as call:
            self.opened(call, self.fixture['full']['replay'])
            changed = call(dict(op='command', type='prefs', seat=0,
                                full_control=False, stops=None, tap_mana='auto'))['state']
            after = self.account(call, full=True, stops={'own': ['Upkeep'], 'others': []})
            self.assertEqual(self.controls(after), self.controls(changed))
        with self.worker() as call:
            opened = self.opened(call, changed['replay'])
            after = self.account(call, full=True)
            self.assertEqual(self.controls(after), self.controls(changed))
            self.assertEqual(after['revision'], opened['revision'])
            self.assertFalse(self.controls(after)['full_control'])
            self.assertIsNone(self.controls(after)['stops'])
            self.assertEqual(self.controls(after)['tap_mana'], 'auto')


if __name__ == '__main__':
    unittest.main()
