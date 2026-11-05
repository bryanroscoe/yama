"""Exercise the plugin archive boundary without uploading or authenticating."""

from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

from package_yama_plugin import FILES, PLUGIN, package


class PluginPackage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="yama-plugin-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "yama"
        shutil.copytree(PLUGIN, self.source)
        self.output = self.root / "yama.zip"

    def test_only_allowed_components_ship_and_rebuilds_are_identical(self):
        (self.source / ".env").write_text("test-secret-do-not-ship")
        (self.source / "unrelated.md").write_text("private scratch")
        package(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(set(archive.namelist()), set(FILES))
            for name in FILES:
                self.assertEqual(archive.read(name), (self.source / name).read_bytes())
            self.assertIsNone(archive.testzip())
        again = self.root / "again.zip"
        package(self.source, again)
        self.assertEqual(self.output.read_bytes(), again.read_bytes())

    def test_symlinked_component_is_refused_before_archive_creation(self):
        icon = self.source / "assets" / "yama-logo-512.png"
        icon.unlink()
        icon.symlink_to(PLUGIN / "assets" / "yama-logo-512.png")
        with self.assertRaisesRegex(ValueError, "symlink"):
            package(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_output_cannot_replace_a_component_or_existing_archive(self):
        before = (self.source / "plugin.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "outside"):
            package(self.source, self.source / "plugin.json")
        self.assertEqual((self.source / "plugin.json").read_bytes(), before)
        self.output.write_bytes(b"prior release")
        with self.assertRaises(FileExistsError):
            package(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"prior release")

    def test_output_aliases_cannot_bypass_source_boundary(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        for output in [self.root / "yama" / ".." / "yama" / "probe.zip", alias / "probe.zip"]:
            with self.subTest(output=output):
                with self.assertRaisesRegex(ValueError, "outside"):
                    package(self.source, output)
        self.assertFalse((self.source / "probe.zip").exists())


if __name__ == "__main__":
    unittest.main()
