"""Checks on the scanner lab's scripts that need no model, data or third-party package.
Run from any directory: python3 -m unittest discover -s scanner-lab -p 'test_*.py'"""
import ast
import os
import re
import sys
import unittest
from pathlib import Path

LAB = Path(__file__).resolve().parent
SCRIPTS = sorted(p for p in LAB.glob("*.py") if p.name != Path(__file__).name)
# Import names to the requirements.txt distributions that provide them.
THIRD_PARTY = {"numpy": "numpy", "cv2": "opencv-python-headless", "onnx": "onnx", "onnxruntime": "onnxruntime",
               "torch": "torch", "torchvision": "torchvision"}


def imports(path):
    names = set()
    for node in ast.walk(ast.parse(path.read_text(), str(path))):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


class ScannerLab(unittest.TestCase):
    def test_every_script_compiles(self):
        self.assertTrue(SCRIPTS)
        for path in SCRIPTS:
            with self.subTest(path.name):
                compile(path.read_text(), str(path), "exec")

    def test_imports_are_the_lab_the_standard_library_or_requirements(self):
        local = {p.stem for p in SCRIPTS}
        required = {re.split(r"[=<>~ ]", line, maxsplit=1)[0].lower()
                    for line in (LAB / "requirements.txt").read_text().splitlines() if line and not line.startswith("#")}
        for path in SCRIPTS:
            for name in imports(path):
                with self.subTest(script=path.name, module=name):
                    if name in local or name in sys.stdlib_module_names:
                        continue
                    # Anything else must be a listed package, never CollectorVision (AGPL) or
                    # its benchmark (cv_bench.py), which stay out of this repository.
                    self.assertIn(name, THIRD_PARTY, f"{path.name} imports {name}")
                    self.assertIn(THIRD_PARTY[name], required)

    def test_no_collectorvision_and_no_machine_paths(self):
        for path in sorted(LAB.iterdir()):
            if path.is_file() and path.suffix in {".py", ".sh", ".md", ".txt"} and path.name != Path(__file__).name:
                text = path.read_text()
                with self.subTest(path.name):
                    self.assertNotRegex(text.lower(), r"import\s+collectorvision|from\s+collectorvision|cv_bench")
                    self.assertNotRegex(text, r"/Users/|/home/[a-z]|\.agent-tasks")

    def test_the_corpus_pull_script_parses(self):
        import subprocess
        subprocess.run(["sh", "-n", str(LAB / "corpus_pull.sh")], check=True)

    def test_a_pulled_export_merges_one_line_per_photo_the_newest(self):
        import json
        import tempfile
        sys.path.insert(0, str(LAB))
        from corpus_merge import merge
        with tempfile.TemporaryDirectory() as dest, tempfile.TemporaryDirectory() as incoming:
            Path(dest, "a.jpg").write_bytes(b"old a")
            Path(dest, "manifest.jsonl").write_text(json.dumps({"id": "a", "kind": "wrong", "created_at": "2026-11-22T01:00:00Z"}) + "\n")
            lines = [{"id": "a", "kind": "corrected", "label_name": "Westvale Abbey", "created_at": "2026-11-22T01:00:00Z"},
                     {"id": "b", "kind": "unconfirmed", "created_at": "2026-11-22T02:00:00Z"}]
            Path(incoming, "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in lines))
            for name in ["a.jpg", "b.jpg", "b.card.jpg", "b.strip.jpg", "notes.txt"]:
                Path(incoming, name).write_bytes(name.encode())
            # c was deleted on the server since the last pull: it isn't shared any more.
            Path(dest, "manifest.jsonl").write_text(Path(dest, "manifest.jsonl").read_text() + json.dumps({"id": "c", "kind": "added"}) + "\n")
            Path(dest, "c.jpg").write_bytes(b"c")
            Path(dest, "c.card.jpg").write_bytes(b"c")
            Path(incoming, "shared_ids.txt").write_text("a\nb\n")
            new, updated, removed, total, kinds = merge(dest, incoming)
            self.assertEqual((new, updated, removed, total), (1, 1, 1, 2))
            self.assertEqual(kinds, {"corrected": 1, "unconfirmed": 1})
            rows = [json.loads(line) for line in Path(dest, "manifest.jsonl").read_text().splitlines()]
            self.assertEqual([(r["id"], r["kind"]) for r in rows], [("a", "corrected"), ("b", "unconfirmed")])
            self.assertEqual(Path(dest, "a.jpg").read_bytes(), b"a.jpg")
            self.assertTrue(Path(dest, "b.card.jpg").exists())
            self.assertFalse(Path(dest, "c.jpg").exists() or Path(dest, "c.card.jpg").exists())
            # Only what the export writes is moved.
            self.assertFalse(Path(dest, "notes.txt").exists())

    def test_an_export_cut_short_is_refused_and_nothing_merged(self):
        import json
        import tempfile
        sys.path.insert(0, str(LAB))
        from corpus_merge import merge
        with tempfile.TemporaryDirectory() as dest, tempfile.TemporaryDirectory() as incoming:
            row = {"id": "a", "kind": "added", "crops": [{"name": "card", "file": "a.card.jpg"}]}
            Path(incoming, "manifest.jsonl").write_text(json.dumps(row) + "\n")
            Path(incoming, "a.jpg").write_bytes(b"a")
            with self.assertRaises(SystemExit):
                merge(dest, incoming)
            self.assertEqual(sorted(os.listdir(dest)), [])


if __name__ == "__main__":
    unittest.main()
