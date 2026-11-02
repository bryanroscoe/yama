#!/usr/bin/env python3
"""Verify the exact source export before compiling it; expected digest comes from Yama's tree."""
import hashlib, json, pathlib, sys

def source_digest(root):
    digest = hashlib.sha256()
    for tree in ('yama', 'yama-phase'):
        for path in sorted((root / tree).rglob('*')):
            if path.is_symlink():
                raise ValueError(f'symlink in source export: {path}')
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            if relative == 'yama/play/src/bin/historical-source.json':
                continue  # generated binding; cannot hash itself
            digest.update(relative.encode() + b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()

if __name__ == '__main__':
    root, expected_path = map(pathlib.Path, sys.argv[1:])
    expected = json.loads(expected_path.read_text())
    actual = source_digest(root)
    if actual != expected['source_sha256']:
        sys.exit(f'historical source provenance mismatch: expected {expected["source_sha256"]}, got {actual}')
    embedded = json.loads((root/'yama/play/src/bin/historical-source.json').read_text())
    if embedded != expected:
        sys.exit('historical embedded source provenance mismatch')
    print(f'historical source verified {actual}')
