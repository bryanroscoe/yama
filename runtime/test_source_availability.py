"""Historical exports fail clearly before creating partial output after cutover."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent


class HistoricalSourceAvailabilityTests(unittest.TestCase):
    def check_missing(self, builder, manifest_path, missing):
        manifest = json.loads((ROOT / manifest_path).read_text())
        with tempfile.TemporaryDirectory() as directory:
            scratch = Path(directory)
            # Model a fresh clone with all other pinned objects available. No
            # archive command should run once a required commit is unavailable.
            git = scratch / "git"
            git.write_text(
                f"#!{sys.executable}\nimport sys\n"
                "assert sys.argv[3:5] == ['cat-file', '-e'], sys.argv\n"
                f"sys.exit(1 if sys.argv[5] == {manifest[missing] + '^{commit}'!r} else 0)\n"
            )
            git.chmod(0o700)
            output = scratch / "export"
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / builder), str(output), "--prepare-only",
                 "--yama-repo", str(scratch / "yama"),
                 "--phase-repo", str(scratch / "phase")],
                env={**os.environ, "PATH": str(scratch) + os.pathsep + os.environ.get("PATH", "")},
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(manifest[missing], result.stderr)
            source = "bryanroscoe/yama-phase" if missing == "phase" else "bryanroscoe/yama-archive"
            self.assertIn(source, result.stderr)
            self.assertIn("--phase-repo" if missing == "phase" else "--yama-repo", result.stderr)
            self.assertIn("Do not replace the manifest pin", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(output.exists(), "missing sources must not leave a partial export")

    def test_each_historical_source_is_required_before_export(self):
        for builder, manifest_path, keys in [
            ("runtime/build-historical.py", "runtime/historical.json", ("yama", "phase")),
            ("runtime/build-v0119.py", "runtime/v0119/historical.json", ("yama", "results_yama", "phase")),
        ]:
            for missing in keys:
                with self.subTest(builder=builder, missing=missing):
                    self.check_missing(builder, manifest_path, missing)


if __name__ == "__main__":
    unittest.main()
