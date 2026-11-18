"""Where the lab's inputs are. Run every script from a work directory outside this repository
(README.md, "Layout"); it writes `data/`, `models/`, `runs/` and `out/` there. These three inputs
can live anywhere, and two of them hold people's data, so they never go in the repository."""
import os

# The pinned ManaVault scanner bundle: manifest.json, embed.onnx, search.onnx and arts.slim.json,
# as the server keeps them in data/scan-bundle/<version>/.
BUNDLE = os.environ.get("SCANNER_BUNDLE_DIR", "bundle")
# Real scan photos: <id>.jpg and manifest.jsonl, as `yama-server scan-samples-export` writes them.
REAL = os.environ.get("SCANNER_REAL_DIR", "data/own")
# A copy of Yama's database, opened read-only, to look up each photo's artwork.
DB = os.environ.get("YAMA_DB", "")


def db_uri():
    if not DB:
        raise SystemExit("Set YAMA_DB to a copy of Yama's database (README.md, \"Inputs\").")
    return f"file:{os.path.abspath(DB)}?mode=ro&immutable=1"
