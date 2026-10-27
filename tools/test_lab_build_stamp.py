"""Exercise the real build script in git and git-less export contexts."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("rustc") and shutil.which("git"), "Rust and git are needed for build-stamp regression tests")
class BuildStampTests(unittest.TestCase):
    def test_native_and_exported_builds_use_the_same_full_revision_and_dirty_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "stamp"
            source = Path(__file__).resolve().parents[1] / "play/build.rs"
            subprocess.run(["rustc", "--edition=2021", str(source), "-o", str(binary)], check=True,
                capture_output=True)
            native = root / "native"
            (native / "play/src").mkdir(parents=True)
            (native / "play/src/lib.rs").write_text("// fixture\n")
            (native / "server/src/lab").mkdir(parents=True)
            (native / "server/src/lab/process.rs").write_text("// original execution policy\n")
            (native / "play/build.rs").write_bytes(source.read_bytes())
            for name in ("Cargo.toml", "Cargo.lock", "play/Cargo.toml"):
                (native / name).write_text("fixture\n")
            subprocess.run(["git", "init", "--quiet", str(native)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(native), "add", "."], check=True)
            subprocess.run(["git", "-C", str(native), "-c", "user.name=Test Fixture", "-c",
                "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], check=True)
            revision = subprocess.check_output(["git", "-C", str(native), "rev-parse", "HEAD"], text=True).strip()
            exported = root / "exported"
            shutil.copytree(native, exported, ignore=shutil.ignore_patterns(".git"))
            base = {key: value for key, value in os.environ.items() if not key.startswith("YAMA_LAB_")}

            def stamp(path, extra):
                output = subprocess.check_output([str(binary)], text=True,
                    env={**base, "CARGO_MANIFEST_DIR": str(path / "play"), **extra})
                return next(line.split("=", 2)[2] for line in output.splitlines()
                    if line.startswith("cargo:rustc-env=YAMA_LAB_RUNNER="))

            self.assertEqual(stamp(native, {}), revision)
            self.assertEqual(stamp(exported, {"YAMA_LAB_GIT_SHA": revision, "YAMA_LAB_GIT_DIRTY": "0"}), revision)
            for tree in (native, exported):
                (tree / "play/src/lib.rs").write_text("// changed fixture\n")
            native_dirty = stamp(native, {})
            self.assertTrue(native_dirty.startswith(revision + "-dirty-"))
            self.assertEqual(native_dirty, stamp(exported,
                {"YAMA_LAB_GIT_SHA": revision, "YAMA_LAB_GIT_DIRTY": "1"}))
            for tree in (native, exported):
                (tree / "play/src/lib.rs").write_text("// fixture\n")
                (tree / "server/src/lab/process.rs").write_text("// different execution policy\n")
            server_dirty = stamp(native, {})
            self.assertTrue(server_dirty.startswith(revision + "-dirty-"))
            self.assertNotEqual(server_dirty, native_dirty)
            self.assertEqual(server_dirty, stamp(exported,
                {"YAMA_LAB_GIT_SHA": revision, "YAMA_LAB_GIT_DIRTY": "1"}))


if __name__ == "__main__":
    unittest.main()
