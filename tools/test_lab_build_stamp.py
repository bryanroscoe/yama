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
            phase = root / "yama-phase"
            phase.mkdir()
            (phase / "Cargo.toml").write_text("// engine fixture\n")
            def phase_git(*args):
                return subprocess.check_output(["git", "-C", str(phase), *args], text=True).strip()
            phase_git("init", "--quiet")
            phase_git("config", "user.name", "Bryan Roscoe")
            phase_git("config", "user.email", "bryanroscoe@gmail.com")
            phase_git("add", "Cargo.toml")
            phase_git("commit", "--quiet", "-m", "engine fixture")
            phase_revision = phase_git("rev-parse", "HEAD")
            native = root / "native"
            (native / "play/src").mkdir(parents=True)
            (native / "play/src/lib.rs").write_text("// fixture\n")
            (native / "server/src/lab").mkdir(parents=True)
            (native / "server/src/lab/process.rs").write_text("// original execution policy\n")
            (native / "play/build.rs").write_bytes(source.read_bytes())
            (native / "runtime").mkdir()
            (native / "deploy").mkdir()
            (native / "deploy/phase-rev").write_text(phase_revision + "\n")
            manifests = ("historical.json", "historical-source.json", "v0119/historical.json", "v0119/historical-source.json")
            for name in manifests:
                path = native / "runtime" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{"identity":"original"}\n')
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
            base.pop("YAMA_PHASE_SOURCE_REV", None)

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
            for name in manifests:
                for tree in (native, exported):
                    (tree / "server/src/lab/process.rs").write_text("// original execution policy\n")
                    for manifest in manifests:
                        (tree / "runtime" / manifest).write_text('{"identity":"original"}\n')
                    (tree / "runtime" / name).write_text('{"identity":"different"}\n')
                runtime_dirty = stamp(native, {})
                self.assertTrue(runtime_dirty.startswith(revision + "-dirty-"), name)
                self.assertNotEqual(runtime_dirty, server_dirty)
                self.assertEqual(runtime_dirty, stamp(exported,
                    {"YAMA_LAB_GIT_SHA": revision, "YAMA_LAB_GIT_DIRTY": "1"}))
            (phase / "Cargo.toml").write_text("// next engine fixture\n")
            phase_git("add", "Cargo.toml")
            phase_git("commit", "--quiet", "-m", "next engine")
            next_phase_revision = phase_git("rev-parse", "HEAD")
            for tree in (native, exported):
                (tree / "deploy/phase-rev").write_text(next_phase_revision + "\n")
            pin_dirty = stamp(native, {})
            self.assertTrue(pin_dirty.startswith(revision + "-dirty-"))
            self.assertNotEqual(pin_dirty, runtime_dirty)
            self.assertEqual(pin_dirty, stamp(exported,
                {"YAMA_LAB_GIT_SHA": revision, "YAMA_LAB_GIT_DIRTY": "1"}))

            def rejected(message, extra=None):
                result = subprocess.run([str(binary)], text=True, capture_output=True,
                    env={**base, "CARGO_MANIFEST_DIR": str(native / "play"), **(extra or {})})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

            # Neither an explicit export marker nor a correct pin masks dirty or
            # different local sources. Direct local builds check Git itself.
            (phase / "Cargo.toml").write_text("// uncommitted engine\n")
            rejected("clean pinned checkout", {"YAMA_PHASE_SOURCE_REV": next_phase_revision})
            phase_git("checkout", "--", "Cargo.toml")
            (native / "deploy/phase-rev").write_text(phase_revision + "\n")
            rejected("must match deploy/phase-rev", {"YAMA_PHASE_SOURCE_REV": phase_revision})
            (native / "deploy/phase-rev").write_text(next_phase_revision + "\n")
            (phase / ".git").rename(root / "phase-git")
            rejected("Git-less Phase source needs")
            rejected("Git-less Phase source needs", {"YAMA_PHASE_SOURCE_REV": phase_revision})
            self.assertEqual(stamp(native, {"YAMA_PHASE_SOURCE_REV": next_phase_revision}), pin_dirty)


if __name__ == "__main__":
    unittest.main()
