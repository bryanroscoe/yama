"""Exercise board packaging without Node dependencies or a WASM compilation."""
import os
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class BoardBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="yama-board-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "yama"
        self.phase = self.root / "phase"
        self.out = self.root / "out"
        (self.repo / "deploy").mkdir(parents=True)
        (self.phase / "client/public/audio").mkdir(parents=True)
        (self.phase / "client/public/battlefield").mkdir()
        (self.phase / "client/public/card-animation-previews").mkdir()
        (self.phase / "scripts").mkdir()
        (self.phase / "client/src/wasm").mkdir(parents=True)
        (self.phase / "client/src/wasm/engine_wasm.d.ts").write_text("pinned declaration")
        (self.phase / "client/.gitignore").write_text("node_modules/\nsrc/wasm/*.wasm\n")
        shutil.copyfile(Path(__file__).with_name("build-board.sh"), self.repo / "deploy/build-board.sh")
        shutil.copyfile(Path(__file__).with_name("build-board-client.sh"), self.repo / "deploy/build-board-client.sh")
        shutil.copyfile(Path(__file__).with_name("board_output.py"), self.repo / "deploy/board_output.py")
        for name in ("LICENSE-MIT", "LICENSE-APACHE", "NOTICE"):
            (self.phase / name).write_text(name)
        for name in ("audio/music.mp3", "battlefield/table.webp", "card-animation-previews/card.mp4"):
            (self.phase / "client/public" / name).write_text(name)
        build = self.phase / "scripts/build-wasm.sh"
        build.write_text('''#!/bin/sh
set -eu
printf '%s\\n' "$PWD" >> "$BUILD_TRACE"
git rev-parse HEAD >> "$BUILD_TRACE"
printf 'generated declaration' > client/src/wasm/engine_wasm.d.ts
printf 'generated wasm' > client/src/wasm/engine_wasm_bg.wasm
if [ "${MOCK_RUST_OUTPUT:-}" = 1 ]; then
    mkdir -p "$CARGO_TARGET_DIR"
    printf 'synthetic test output' > "$CARGO_TARGET_DIR/artifact-fixture"
fi
''')
        build.chmod(0o755)
        self.git("init", "--quiet")
        self.git("add", ".")
        self.git("-c", "user.name=Build test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        (self.repo / "deploy/phase-rev").write_text(self.sha + "\n")
        bindir = self.root / "bin"
        bindir.mkdir()
        pnpm = bindir / "pnpm"
        pnpm.write_text('''#!/usr/bin/env python3
import os, pathlib, shutil, sys
if sys.argv[1] == "install":
    pathlib.Path("node_modules").mkdir()
    pathlib.Path("node_modules/installed").write_text("dependency state")
    for family in ("newsreader", "jetbrains-mono"):
        license = pathlib.Path("node_modules/@fontsource-variable") / family / "LICENSE"
        license.parent.mkdir(parents=True)
        license.write_text("font license " + family)
    sys.exit(0)
assert os.environ["PHASE_BUILD_REVISION"] == os.environ["EXPECTED_PHASE_REVISION"]
assert os.environ["PHASE_BASE_PATH"] == "/board/"
assert os.environ["VITE_TEXT_ICONS"] == "1"
assert os.environ["DATA_BASE_URL"] == "/api/play/board-data"
stage = pathlib.Path(os.environ["PHASE_PUBLIC_DIR"])
assert stage.is_dir()
if os.environ.get("FAIL_BUILD"):
    sys.exit(7)
if os.environ.get("CHANGE_OUTPUT"):
    pathlib.Path(os.environ["CHANGE_OUTPUT"]).write_text("work added during build")
out = pathlib.Path(sys.argv[sys.argv.index("--outDir") + 1])
shutil.copytree(stage, out, dirs_exist_ok=True)
''')
        pnpm.chmod(0o755)
        self.trace = self.root / "build-calls"
        self.env = {**os.environ, "PATH": str(bindir) + os.pathsep + os.environ["PATH"], "BUILD_TRACE": str(self.trace)}
        self.env.pop("CARGO_TARGET_DIR", None)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.phase), *args], text=True)

    def build(self):
        return subprocess.run(["bash", str(self.repo / "deploy/build-board.sh"), str(self.phase), str(self.out)],
                              env={**self.env, "EXPECTED_PHASE_REVISION": (self.repo / "deploy/phase-rev").read_text().strip()}, capture_output=True, text=True)

    def test_packages_media_without_touching_source(self):
        source = self.phase / "client/public/audio/music.mp3"
        source.write_text("local work")
        untracked = self.phase / "client/public/local.txt"
        untracked.write_text("keep")
        owned_dependencies = self.phase / "client/node_modules/local"
        owned_dependencies.parent.mkdir()
        owned_dependencies.write_text("keep dependencies")
        before = self.git("status", "--porcelain")
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.out / "audio/music.mp3").read_text(), "audio/music.mp3")
        self.assertTrue((self.out / "battlefield/table.webp").is_file())
        self.assertTrue((self.out / "licenses/LICENSE-MIT").is_file())
        self.assertEqual((self.out / "licenses/newsreader/LICENSE").read_text(), "font license newsreader")
        self.assertEqual((self.out / "licenses/jetbrains-mono/LICENSE").read_text(), "font license jetbrains-mono")
        self.assertEqual(json.loads((self.out / "yama-board.json").read_text()), {"phase_revision": self.sha})
        self.assertFalse((self.out / "card-animation-previews/card.mp4").exists())
        self.assertFalse((self.out / "local.txt").exists())
        self.assertEqual(source.read_text(), "local work")
        self.assertEqual(untracked.read_text(), "keep")
        self.assertEqual((self.phase / "client/src/wasm/engine_wasm.d.ts").read_text(), "pinned declaration")
        self.assertFalse((self.phase / "client/src/wasm/engine_wasm_bg.wasm").exists())
        self.assertEqual(owned_dependencies.read_text(), "keep dependencies")
        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertEqual(list(self.root.glob(".board-build.*")), [])
        # Recheck WASM on every invocation, even when the preceding output exists.
        self.assertEqual(self.build().returncode, 0)
        trace = self.trace.read_text().splitlines()
        self.assertEqual(trace[1::2], [self.sha, self.sha])
        self.assertTrue(all(Path(p) != self.phase and not Path(p).exists() for p in trace[::2]))

    def test_failure_cleans_staging_and_preserves_sources(self):
        self.assertEqual(self.build().returncode, 0)
        prior_output = {str(p.relative_to(self.out)): p.read_bytes() for p in self.out.rglob("*") if p.is_file()}
        self.env["FAIL_BUILD"] = "1"
        before = self.git("status", "--porcelain")
        result = self.build()
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(list(self.root.glob(".board-build.*")), [])
        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertEqual((self.phase / "client/src/wasm/engine_wasm.d.ts").read_text(), "pinned declaration")
        self.assertFalse((self.phase / "client/node_modules").exists())
        self.assertEqual({str(p.relative_to(self.out)): p.read_bytes() for p in self.out.rglob("*") if p.is_file()}, prior_output)
        self.assertTrue((self.phase / "client/public/card-animation-previews/card.mp4").is_file())

    def test_uses_pinned_npx_when_pnpm_is_not_installed(self):
        bindir = Path(self.env["PATH"].split(os.pathsep)[0])
        (bindir / "pnpm").rename(bindir / "pnpm-fixture")
        node = bindir / "node"
        node.write_text("#!/bin/sh\nprintf '9.15.9\\n'\n")
        node.chmod(0o755)
        npx = bindir / "npx"
        npx.write_text('''#!/bin/sh
set -eu
test "$1" = -y
test "$2" = pnpm@9.15.9
shift 2
exec "$(dirname "$0")/pnpm-fixture" "$@"
''')
        npx.chmod(0o755)
        # Isolate PATH so this also exercises the fallback on CI hosts with pnpm.
        for name in ("bash", "cp", "dirname", "git", "mkdir", "mktemp", "python3", "rm", "tar", "tr"):
            (bindir / name).symlink_to(shutil.which(name))
        self.env["PATH"] = str(bindir)
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.out / "yama-board.json").is_file())

    def test_wrong_engine_revision_is_refused_before_build(self):
        (self.repo / "deploy/phase-rev").write_text("0" * 40 + "\n")
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not contain pinned revision", result.stderr)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.trace.exists())

    def test_builds_the_pin_when_the_supplied_checkout_has_advanced(self):
        source = self.phase / "client/public/audio/music.mp3"
        source.write_text("newer source")
        self.git("add", ".")
        self.git("-c", "user.name=Build test", "-c", "user.email=test@example.invalid", "commit", "-qm", "newer")
        head = self.git("rev-parse", "HEAD")
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.out / "audio/music.mp3").read_text(), "audio/music.mp3")
        self.assertEqual(self.trace.read_text().splitlines()[1], self.sha)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertEqual(source.read_text(), "newer source")

    def test_refuses_output_or_cache_inside_the_supplied_checkout(self):
        self.out = self.phase / "output"
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("output must be outside", result.stderr)
        self.assertFalse(self.out.exists())
        self.out = self.root / "out"
        self.env["CARGO_TARGET_DIR"] = str(self.phase / "target")
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cache must be outside", result.stderr)
        self.assertFalse(self.out.exists())

    def test_source_roots_ancestors_and_yama_source_directories_are_rejected(self):
        original = (self.repo / "deploy/build-board.sh").read_bytes()
        for output in [self.root, self.repo, self.phase, self.repo / "deploy"]:
            self.out = output
            result = self.build()
            self.assertNotEqual(result.returncode, 0, str(output))
            self.assertIn("Board output:", result.stderr)
            self.assertEqual((self.repo / "deploy/build-board.sh").read_bytes(), original)
            self.assertTrue((self.phase / "client/public/audio/music.mp3").is_file())
            self.assertFalse(self.trace.exists(), "source protection runs before any build")

    def test_symlink_to_a_source_ancestor_is_rejected(self):
        self.out = self.root / "alias"
        self.out.symlink_to(self.root, target_is_directory=True)
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not contain", result.stderr)
        self.assertFalse(self.trace.exists())

    def test_root_level_destination_preserves_its_parent(self):
        # The root-level destination is virtual: stop at mktemp and intercept
        # mkdir so this test never writes to the host's filesystem root. The
        # destination policy itself is covered by the source/ownership tests.
        self.out = Path("/") / self.root.name
        (self.repo / "deploy/board_output.py").write_text("import sys\nassert sys.argv[1] == 'check'\n")
        trace = self.root / "parent-commands"
        self.env["PARENT_TRACE"] = str(trace)
        bindir = Path(self.env["PATH"].split(os.pathsep)[0])
        for name in ("mkdir", "mktemp"):
            command = bindir / name
            command.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
with open(os.environ["PARENT_TRACE"], "a") as f:
    f.write(json.dumps([name, *sys.argv[1:]]) + "\\n")
if name == "mkdir":
    sys.exit(0 if sys.argv[1:] == ["-p", "/"] else 1)
sys.exit(42)
''')
            command.chmod(0o755)
        result = self.build()
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertEqual([json.loads(line) for line in trace.read_text().splitlines()], [
            ["mkdir", "-p", "/"],
            ["mktemp", "-d", "/.board-build.XXXXXX"],
        ])
        self.assertFalse(self.trace.exists(), "no compilation was started")

    def test_unmanaged_nonempty_output_is_preserved(self):
        self.out.mkdir()
        note = self.out / "uncommitted-work.txt"
        note.write_text("keep")
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("nonempty output is unmanaged", result.stderr)
        self.assertEqual(note.read_text(), "keep")
        self.assertFalse(self.trace.exists())

    def test_modified_managed_output_is_preserved(self):
        self.assertEqual(self.build().returncode, 0)
        note = self.out / "audio/music.mp3"
        note.write_text("local changes")
        before = self.trace.read_text()
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("modified or unowned", result.stderr)
        self.assertEqual(note.read_text(), "local changes")
        self.assertEqual(self.trace.read_text(), before)

    def test_managed_rebuild_retires_only_owned_obsolete_files(self):
        self.assertEqual(self.build().returncode, 0)
        self.git("rm", "client/public/audio/music.mp3")
        self.git("-c", "user.name=Build test", "-c", "user.email=test@example.invalid", "commit", "-qm", "retire asset")
        self.sha = self.git("rev-parse", "HEAD").strip()
        (self.repo / "deploy/phase-rev").write_text(self.sha + "\n")
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.out / "audio/music.mp3").exists())
        self.assertTrue((self.out / "battlefield/table.webp").is_file())
        self.assertEqual(json.loads((self.out / "yama-board.json").read_text())["phase_revision"], self.sha)

    def test_added_entries_in_managed_output_are_preserved(self):
        self.assertEqual(self.build().returncode, 0)
        before = self.trace.read_text()
        entry = self.out / "local-work"
        for kind in ("file", "directory", "symlink"):
            with self.subTest(kind=kind):
                if kind == "file":
                    entry.write_text("keep")
                elif kind == "directory":
                    entry.mkdir()
                else:
                    entry.symlink_to(self.repo, target_is_directory=True)
                result = self.build()
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(entry.exists())
                self.assertEqual(self.trace.read_text(), before)
                if kind == "directory":
                    entry.rmdir()
                else:
                    entry.unlink()

    def test_changes_during_build_prevent_publication(self):
        self.assertEqual(self.build().returncode, 0)
        marker = (self.out / "yama-board.json").read_bytes()
        note = self.out / "local-work.txt"
        self.env["CHANGE_OUTPUT"] = str(note)
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(note.read_text(), "work added during build")
        self.assertEqual((self.out / "yama-board.json").read_bytes(), marker)
        self.assertEqual(list(self.root.glob(".board-build.*")), [])

    def test_documented_generated_output_inside_yama_is_supported(self):
        self.out = self.repo / "web/board-dist"
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.out / ".yama-board-files.json").is_file())
        self.assertEqual(self.build().returncode, 0)

    def mock_rust_cleanup(self):
        self.env["MOCK_RUST_OUTPUT"] = "1"
        self.env["CLEAN_TRACE"] = str(self.root / "clean-calls")
        cleaner = Path(self.env["PATH"].split(os.pathsep)[0]) / "agent-clean"
        cleaner.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
with open(os.environ["CLEAN_TRACE"], "a") as f:
    f.write(json.dumps(args) + "\\n")
if os.environ.get("REFUSE_CLEANUP"):
    sys.exit(9)
if "--apply" in args:
    # Only the synthetic test fixture, never actual Cargo output.
    shutil.rmtree(args[args.index("--target-dir") + 1])
''')
        cleaner.chmod(0o755)

    def test_disposable_rust_output_uses_preview_then_supported_cleanup(self):
        self.mock_rust_cleanup()
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in Path(self.env["CLEAN_TRACE"]).read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertNotIn("--apply", calls[0])
        self.assertIn("--apply", calls[1])
        self.assertEqual(calls[0][calls[0].index("--target-dir") + 1], calls[1][calls[1].index("--target-dir") + 1])
        self.assertEqual(list(self.root.glob(".board-build.*")), [])

    def test_cleanup_refusal_retains_scratch_and_reports_failure(self):
        self.mock_rust_cleanup()
        self.env["REFUSE_CLEANUP"] = "1"
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("scratch retained after cleanup refusal", result.stderr)
        retained = list(self.root.glob(".board-build.*"))
        self.assertEqual(len(retained), 1)
        self.assertTrue((retained[0] / "target/artifact-fixture").is_file())
        self.assertEqual((self.phase / "client/src/wasm/engine_wasm.d.ts").read_text(), "pinned declaration")


if __name__ == "__main__":
    unittest.main()
