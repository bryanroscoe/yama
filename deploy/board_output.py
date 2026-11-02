"""Validate and publish a staged board bundle without clearing source trees."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


MANIFEST = ".yama-board-files.json"


def contains(parent: Path, child: Path) -> bool:
    """Also recognise existing case aliases on case-insensitive filesystems."""
    return any(parent == p or (parent.exists() and p.exists() and os.path.samefile(parent, p))
               for p in (child, *child.parents))


def validate_path(output: Path, repo: Path, phase: Path) -> None:
    for source in (repo, phase):
        if contains(output, source):
            raise ValueError("output must not contain either source checkout")
    if contains(phase, output):
        raise ValueError("output must be outside the supplied Phase checkout")
    # These are the documented generated destinations within Yama. Source
    # subdirectories, including a newly created one, are never output targets.
    if contains(repo, output) and output not in (repo / "board-dist", repo / "web/board-dist"):
        raise ValueError("output inside Yama must use board-dist or web/board-dist")


def inventory(directory: Path) -> dict[str, str]:
    files = {}
    for p in directory.rglob("*"):
        if p.is_symlink() or p.name == ".git":
            raise ValueError("output contains a symlink or source checkout")
        if p.is_dir():
            files[p.relative_to(directory).as_posix() + "/"] = ""
        elif p.is_file() and p != directory / MANIFEST:
            digest = hashlib.sha256()
            with p.open("rb") as f:
                for block in iter(lambda: f.read(1024 * 1024), b""):
                    digest.update(block)
            files[p.relative_to(directory).as_posix()] = digest.hexdigest()
        elif p != directory / MANIFEST:
            raise ValueError("output contains an unsupported filesystem entry")
    return files


def validate_owned(output: Path) -> None:
    if not output.exists():
        return
    if not output.is_dir() or output.is_symlink():
        raise ValueError("output must be a directory")
    if not any(output.iterdir()):
        return
    manifest = output / MANIFEST
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("nonempty output is unmanaged; choose an empty output directory")
    data = json.loads(manifest.read_text())
    if (not isinstance(data, dict) or data.get("version") != 1
            or data.get("files") != inventory(output) or "yama-board.json" not in data["files"]):
        raise ValueError("output has modified or unowned files; its contents were preserved")


def publish(built: Path, output: Path, repo: Path, phase: Path) -> None:
    validate_path(output, repo, phase)
    validate_owned(output)
    files = inventory(built)
    if "yama-board.json" not in files:
        raise ValueError("built bundle is missing its revision marker")
    (built / MANIFEST).write_text(json.dumps({"version": 1, "files": files}, sort_keys=True) + "\n")
    previous = built.parent / "previous-output"
    if previous.exists():
        raise ValueError("publication staging already contains a previous output")
    moved = False
    if output.exists():
        output.rename(previous)
        moved = True
    try:
        # Recheck after moving, before deleting anything. Changes made during
        # the build cause publication to fail with the original output restored.
        if moved:
            validate_owned(previous)
        built.rename(output)
    except BaseException:
        if moved:
            previous.rename(output)
        raise
    if moved:
        shutil.rmtree(previous)


def main() -> None:
    command, *args = sys.argv[1:]
    if command == "check":
        output, repo, phase = (Path(p).resolve() for p in args)
        validate_path(output, repo, phase)
        validate_owned(output)
    elif command == "publish":
        built, output, repo, phase = (Path(p).resolve() for p in args)
        publish(built, output, repo, phase)
    else:
        raise ValueError("unknown board output command")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Board output: {error}", file=sys.stderr)
        sys.exit(1)
