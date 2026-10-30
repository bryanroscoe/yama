"""Overlay a Forge patch set on the Forge release jar (deploy/Dockerfile.forge-worker).

    python3 patch_jar.py FORGE_DIR PATCH_JAR SHA256 NAME

The patch jar (built and kept outside Yama, in forge-referee: Forge is GPL-3.0 and none of its code is in
Yama) holds compiled classes only. This checks its SHA-256 against the pin, writes a copy of the release jar
with those entries replaced (or added), and renames it forge-gui-desktop-<version>+<NAME>.<sha8>-jar-with-dependencies.jar
(<sha8>: the first 8 hex digits of the patch jar's SHA-256), so the runner's engine label becomes
"forge <version>+<NAME>.<sha8>": patched results are never pooled with stock ones, nor with another patch jar's.
The release jar is removed: the runner uses the only forge-gui-desktop jar it finds.
"""
import hashlib
import os
import re
import sys
import zipfile
from pathlib import Path

JAR_RE = re.compile(r"forge-gui-desktop-(.+)-jar-with-dependencies\.jar")


def patch(forge_dir, patch_jar, sha256, name):
    forge_dir, patch_jar = Path(forge_dir), Path(patch_jar)
    if not re.fullmatch(r"[a-z0-9]+", name):
        raise SystemExit(f"patch name {name!r}: use lower-case letters and digits")
    got = hashlib.sha256(patch_jar.read_bytes()).hexdigest()
    if got != sha256.lower():
        raise SystemExit(f"{patch_jar}: SHA-256 {got}, expected {sha256}")
    jars = sorted(forge_dir.glob("forge-gui-desktop-*-jar-with-dependencies.jar"))
    if len(jars) != 1:
        raise SystemExit(f"{forge_dir}: expected one forge-gui-desktop jar, found {[j.name for j in jars]}")
    release = jars[0]
    version = JAR_RE.fullmatch(release.name).group(1)
    if "+" in version:
        raise SystemExit(f"{release.name} is already patched")
    with zipfile.ZipFile(patch_jar) as pz:
        entries = {i.filename: pz.read(i) for i in pz.infolist() if not i.is_dir()}
    if not entries or any(not n.endswith(".class") for n in entries):
        raise SystemExit(f"{patch_jar}: a patch set holds compiled classes only")
    out = forge_dir / f"forge-gui-desktop-{version}+{name}.{got[:8]}-jar-with-dependencies.jar"
    tmp = out.with_name(out.name + ".partial")
    with zipfile.ZipFile(release) as rz:
        names = {i.filename for i in rz.infolist()}
    # A recompiled class's inner classes (Outer$1.class) must all come from the patch set, or old and new would mix.
    for n in entries:
        if n in names:
            stem = n[:-len(".class")]
            stale = sorted(m for m in names if m.startswith(stem + "$") and m.endswith(".class") and m not in entries)
            if stale:
                raise SystemExit(f"{patch_jar}: replaces {n} but not its inner classes {stale}")
    replaced = 0
    try:
        with zipfile.ZipFile(release) as rz, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as oz:
            for info in rz.infolist():
                if info.filename in entries:
                    replaced += 1
                    oz.writestr(info, entries.pop(info.filename))
                else:
                    oz.writestr(info, rz.read(info))
            for n, data in sorted(entries.items()):  # classes the patch set adds
                oz.writestr(zipfile.ZipInfo(n, (2026, 1, 1, 0, 0, 0)), data, zipfile.ZIP_DEFLATED)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    if replaced == 0:
        tmp.unlink()
        raise SystemExit(f"{patch_jar}: replaces no class of {release.name}; wrong Forge version?")
    os.replace(tmp, out)
    release.unlink()
    return out, replaced, len(entries)


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    out, replaced, added = patch(*sys.argv[1:])
    print(f"forge patch: {out.name} ({replaced} classes replaced, {added} added)")
