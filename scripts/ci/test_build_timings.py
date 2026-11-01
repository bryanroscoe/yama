"""Test the cargo timing summary. Run: python3 -m unittest discover -s scripts/ci -p 'test_*.py'"""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_timings  # noqa: E402

HTML = '''<script>
const UNIT_DATA = [{"i":0,"name":"phase-engine","version":"0.1.0","mode":"todo","target":"","start":0.1,"duration":150.5},
{"i":1,"name":"yama-play","version":"0.1.0","mode":"todo","target":" test \\"turns\\"","start":2.0,"duration":30.0}];
const CONCURRENCY_DATA = [];
</script>'''


class Timings(unittest.TestCase):
    def test_slowest_first(self):
        text = build_timings.table(build_timings.units(HTML), 5)
        self.assertIn('2 units, 180s', text)
        self.assertLess(text.index('phase-engine'), text.index('yama-play'))
        self.assertIn('yama-play test "turns"', text)

    def test_prints_and_removes_the_report(self):
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp, 'cargo-timings')
            report.mkdir()
            (report / 'cargo-timing.html').write_text(HTML)
            (report / 'cargo-timing-20261101T000000Z.html').write_text(HTML)
            result = subprocess.run([sys.executable, str(HERE / 'build_timings.py'), temp, '1'],
                                    capture_output=True, text=True, check=True)
            self.assertIn('phase-engine', result.stdout)
            self.assertNotIn('yama-play', result.stdout)
            self.assertFalse(report.exists())

    def test_missing_report_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run([sys.executable, str(HERE / 'build_timings.py'), temp],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn('No timing report', result.stdout)


if __name__ == '__main__':
    unittest.main()
