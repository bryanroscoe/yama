import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('verify_source', HERE/'verify-source.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)

class SourceProvenance(unittest.TestCase):
    def test_changed_source_with_identical_embedded_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            binary = root/'yama/play/src/bin'
            binary.mkdir(parents=True)
            (root/'yama-phase').mkdir()
            source = root/'yama-phase/engine.rs'
            source.write_text('original engine')
            (binary/'historical.json').write_text('{"identity":"unchanged"}')
            expected = {'source_sha256':verify.source_digest(root)}
            manifest = root/'expected.json'
            manifest.write_text(json.dumps(expected))
            (binary/'historical-source.json').write_text(json.dumps(expected))
            def check():
                return subprocess.run(['python3',str(HERE/'verify-source.py'),str(root),str(manifest)],capture_output=True,text=True)
            self.assertEqual(check().returncode,0)
            source.write_text('altered engine')
            result = check()
            self.assertNotEqual(result.returncode,0)
            self.assertIn('source provenance mismatch',result.stderr)

    def test_embedded_binding_must_equal_independent_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            binary=root/'yama/play/src/bin'
            binary.mkdir(parents=True)
            (root/'yama-phase').mkdir()
            expected={'source_sha256':verify.source_digest(root)}
            manifest=root/'expected.json'
            manifest.write_text(json.dumps(expected))
            (binary/'historical-source.json').write_text('{}')
            result=subprocess.run(['python3',str(HERE/'verify-source.py'),str(root),str(manifest)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('embedded source provenance mismatch',result.stderr)

@unittest.skipUnless(os.environ.get('YAMA_HISTORICAL_RUNTIME') and os.environ.get('YAMA_HISTORICAL_CARD_DATA'),
                     'requires the built, bound historical runtime and real pinned data')
class NativePreflight(unittest.TestCase):
    def probe(self, data):
        return subprocess.run([os.environ['YAMA_HISTORICAL_RUNTIME'], '--verify-data', str(data)],
                              env={}, capture_output=True, text=True, timeout=60)

    def test_real_pinned_data_emits_bounded_verified_provenance(self):
        result = self.probe(os.environ['YAMA_HISTORICAL_CARD_DATA'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(len(result.stdout.encode()), 4096)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        value = json.loads(result.stdout)
        self.assertIs(value['verified'], True)
        self.assertGreater(value['cards'], 0)
        self.assertEqual(value['source'], json.loads((HERE/'historical-source.json').read_text()))

    def test_matching_filename_does_not_authenticate_corrupt_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            data = pathlib.Path(directory)/'card-data-1e5608e61683de41.json'
            data.write_text('not JSON; reject the bytes before parsing')
            result = self.probe(data)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            self.assertIn('content mismatch', result.stderr)

if __name__=='__main__':unittest.main()
