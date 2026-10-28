import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from prepare_playgroup import prepare, canonical, local_file, timestamp


class PrepareTests(unittest.TestCase):
    def fixture(self, root):
        payload=canonical([{"id":1,"name":"Commander"}])
        sha=hashlib.sha256(payload).hexdigest()
        (root/'catalog.gz').write_bytes(gzip.compress(payload,mtime=0))
        manifest={"schema":"yama-source-recovery/1","created_at":"2026-10-28T00:00:00Z","sources":[{
            "kind":"current_commander_aggregate_catalog","status":"recovered","file":"catalog.gz","sha256":sha,
            "retrieval_url":"https://example.com/catalog","retrieved_at":"2026-10-28T00:00:00Z"}]}
        (root/'manifest.json').write_bytes(canonical(manifest))
        (root/'coverage.json').write_text('{}')
        (root/'observations.jsonl').write_text('')
        (root/'weekly-activity.jsonl').write_text('')
        (root/'commander-catalog.jsonl').write_text('{"id":1,"name":"Commander"}\n')

    def test_deterministic_bundle_retains_source_links_and_has_no_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.fixture(root)
            a=prepare(root);b=prepare(root)
            self.assertEqual(canonical(a),canonical(b))
            self.assertNotIn('owner_id',a)
            self.assertEqual(a['records'][0]['kind'],'commander')
            self.assertEqual(a['records'][0]['sources'],[a['sources'][0]['sha256']])
            self.assertNotIn(str(root),canonical(a).decode())

    def test_corrupt_source_and_outside_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.fixture(root)
            with self.assertRaises(ValueError):local_file(root,'../anything')
            (root/'catalog.gz').write_bytes(gzip.compress(b'changed'))
            with self.assertRaisesRegex(ValueError,'hash mismatch'):prepare(root)

    def test_undated_and_timezone_free_timestamps_are_not_silently_invented(self):
        self.assertIsNone(timestamp(None))
        self.assertEqual(timestamp('2026-10-17T16:02Z'),'2026-10-17T16:02:00Z')
        with self.assertRaises(ValueError):timestamp('2026-10-17T16:02')


if __name__=='__main__':unittest.main()
