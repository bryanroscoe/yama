#!/usr/bin/python3
"""Remove job checkouts/dependencies after post-actions; preserve the one warm cache."""
import os
import shutil
from pathlib import Path

# Fixed installed paths, never a path supplied by repository code or an event.
root = Path('/runner-state/_work')
for name in ('yama', '_temp'):
    path = root / name
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)
print('CI job checkout and temporary files removed; dedicated compiler/npm cache retained.', flush=True)
os.stat('/ci-cache')  # A missing cache mount is an installation error.
