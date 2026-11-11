"""Real frozen-v0.119 replay/control tests; explicitly skipped without its artifacts."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import test_historical_controls as legacy


class V0119Controls(legacy.HistoricalControls):
    __unittest_skip__ = not (os.environ.get('YAMA_V0119_RUNTIME') and os.environ.get('YAMA_V0119_CARD_DATA'))
    __unittest_skip_why__ = 'requires the built frozen v0.119 runtime and verified data'
    recipe = Path(__file__).resolve().parent / 'v0119'
    binary_env = 'YAMA_V0119_RUNTIME'
    data_env = 'YAMA_V0119_CARD_DATA'

    @staticmethod
    def controls(state):
        sidecar = json.loads(state['replay'])['yama_turn_controls']
        assert sidecar['version'] == 1
        return sidecar['seats']['0']

    def test_native_preflight_binds_real_data_and_source(self):
        result = subprocess.run([self.binary, '--verify-data', self.data], env={},
                                capture_output=True, text=True, timeout=90, check=True)
        self.assertLess(len(result.stdout), 4096)
        value = json.loads(result.stdout)
        self.assertIs(value['verified'], True)
        self.assertGreater(value['cards'], 0)
        self.assertEqual(value['source'], json.loads((self.recipe/'historical-source.json').read_text()))
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)/'card-data-cbd552b41f962f5b.json'
            data.write_text('wrong bytes, regardless of filename')
            bad = subprocess.run([self.binary, '--verify-data', str(data)], env={},
                                 capture_output=True, text=True, timeout=90)
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn('content mismatch', bad.stderr)

    def test_end_solo_remains_abandoned_after_recovery(self):
        with self.worker() as call:
            opened = self.opened(call, self.fixture['live']['replay'])
            ended = call(dict(op='command', type='end_solo', seat=0))['state']
            self.assertTrue(ended['over'])
            self.assertTrue(ended['abandoned'])
            self.assertIsNone(ended['winner'])
            self.assertGreater(ended['revision'], opened['revision'])
            self.assertTrue(json.loads(ended['replay'])['yama_abandoned'])
        with self.worker() as call:
            restored = self.opened(call, ended['replay'])
            self.assertTrue(restored['abandoned'])
            self.assertTrue(restored['over'])
            self.assertIsNone(restored['winner'])


if __name__ == '__main__':
    unittest.main()
