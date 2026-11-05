"""Build the private Yama plugin ZIP without including local files or credentials.

Usage: python3 scripts/package_yama_plugin.py /absolute/path/outside/plugin/yama.zip
"""

import argparse
import json
from pathlib import Path
import zipfile


PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "yama"
# Deliberate allowlist: do not ship an entire repository, local .env, or scratch.
FILES = (
    "plugin.json",
    "mcp.json",
    "assets/yama-logo-512.png",
    "assets/yama-icon-120.png",
    "skills/yama-setup/SKILL.md",
    "skills/yama-setup/agents/openai.yaml",
    "skills/yama-deck-building/SKILL.md",
    "skills/yama-deck-building/agents/openai.yaml",
    "skills/yama-collection-planning/SKILL.md",
    "skills/yama-collection-planning/agents/openai.yaml",
    "skills/yama-commander-research/SKILL.md",
    "skills/yama-commander-research/agents/openai.yaml",
    "skills/yama-commander-research/references/research-format.md",
)


def package(source: Path, output: Path) -> None:
    source = source.absolute()
    output = output.absolute()
    if output.resolve().is_relative_to(source.resolve()):
        raise ValueError("write the archive outside the plugin source directory")
    contents = {}
    for name in FILES:
        path = source / name
        if any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError(f"refusing symlink in plugin source: {name}")
        contents[name] = path.read_bytes()
    for name in ("plugin.json", "mcp.json"):
        json.loads(contents[name])
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for name, data in contents.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 5, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    package(PLUGIN, args.output)
    print(f"Built {args.output.absolute()}")
