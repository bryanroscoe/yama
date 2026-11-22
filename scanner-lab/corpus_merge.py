"""Merge a pulled scan photo export into the lab's corpus folder (corpus_pull.sh runs it).

`python3 corpus_merge.py DEST INCOMING`: the photos and crops in INCOMING (`<id>.jpg`,
`<id>.<crop>.jpg`, as `yama-server scan-samples-export` writes them) move into DEST, and DEST's
manifest.jsonl keeps one line per photo, the newest: a photo relabelled since an earlier pull (a card
called wrong, then filed) comes again with its new label. Prints what changed, by kind. Standard
library only. The photos are people's data: DEST stays outside the repository and anything public."""
import collections
import json
import os
import re
import sys

# What the export writes: a photo, or one of its crops. Anything else in INCOMING is left alone.
FILE = re.compile(r"^[A-Za-z0-9_-]{1,64}(\.(symbol|strip|card))?\.jpg$")


def read_manifest(path):
    rows = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.strip():
                    row = json.loads(line)
                    rows[row["id"]] = row
    return rows


def merge(dest, incoming):
    """Returns (photos new to DEST, photos updated, photos in DEST, the new manifest's kinds)."""
    path = os.path.join(dest, "manifest.jsonl")
    rows = read_manifest(path)
    new = updated = 0
    for row in read_manifest(os.path.join(incoming, "manifest.jsonl")).values():
        if row["id"] in rows:
            updated += 1
        else:
            new += 1
        rows[row["id"]] = row
    for name in sorted(os.listdir(incoming)):
        if FILE.match(name):
            os.replace(os.path.join(incoming, name), os.path.join(dest, name))
    part = path + ".part"
    with open(part, "w") as f:
        for row in sorted(rows.values(), key=lambda r: (r.get("created_at") or "", r["id"])):
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(part, path)
    kinds = collections.Counter(r.get("kind") for r in rows.values())
    return new, updated, len(rows), dict(kinds)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: python3 corpus_merge.py DEST INCOMING")
    new, updated, total, kinds = merge(sys.argv[1], sys.argv[2])
    by_kind = ", ".join(f"{n} {k}" for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]))
    print(f"{new} new photos, {updated} updated; {total} in all ({by_kind}).")


if __name__ == "__main__":
    main()
