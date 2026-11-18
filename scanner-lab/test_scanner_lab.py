"""Checks on the scanner lab's scripts that need no model, data or third-party package.
Run from any directory: python3 -m unittest discover -s scanner-lab -p 'test_*.py'"""
import ast
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


if __name__ == "__main__":
    unittest.main()
