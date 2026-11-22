"""Merge a pulled scan photo export into the lab's corpus folder (corpus_pull.sh runs it).

`python3 corpus_merge.py DEST INCOMING`: the photos and crops in INCOMING (`<id>.jpg`,
`<id>.<crop>.jpg`, as `yama-server scan-samples-export` writes them) move into DEST, and DEST's
manifest.jsonl keeps one line per photo, the newest: a photo relabelled since an earlier pull (a card
called wrong, then filed) comes again with its new label. A photo no longer shared on the server
(deleted by its owner's Delete them, with its account, or by the caps: not in the export's
shared_ids.txt) goes from DEST too, files and line, so the copy is never kept longer than the
server keeps it. An export missing a file its manifest lists, or that list, is refused, and DEST is
left as it was.
Prints what changed, by kind. Standard library only. The photos are people's data: DEST stays
outside the repository and anything public."""
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


def missing_files(incoming, rows):
    """The files the manifest lists that INCOMING hasn't got: a copy cut short."""
    want = []
    for row in rows.values():
        want.append(f"{row['id']}.jpg")
        want += [c["file"] for c in row.get("crops") or [] if c.get("file")]
    return [name for name in want if not os.path.exists(os.path.join(incoming, name))]


def merge(dest, incoming):
    """Returns (photos new to DEST, photos updated, photos removed, photos in DEST, the kinds)."""
    path = os.path.join(dest, "manifest.jsonl")
    rows = read_manifest(path)
    pulled = read_manifest(os.path.join(incoming, "manifest.jsonl"))
    missing = missing_files(incoming, pulled)
    if missing:
        raise SystemExit(f"The export is missing {len(missing)} files it lists ({missing[:3]}): nothing merged. Pull again.")
    # Without the list of what the server shares now, nothing deleted there could go here: refused
    # (Codex review of #197), as an export cut short is.
    if not os.path.exists(os.path.join(incoming, "shared_ids.txt")):
        raise SystemExit("The export has no shared_ids.txt (a server from before 22 Nov 2026, or a copy cut short): nothing merged.")
    with open(os.path.join(incoming, "shared_ids.txt")) as f:
        shared = {line.strip() for line in f if line.strip()}
    new = updated = 0
    for row in pulled.values():
        if row["id"] in rows:
            updated += 1
        else:
            new += 1
        rows[row["id"]] = row
    for name in sorted(os.listdir(incoming)):
        if FILE.match(name):
            os.replace(os.path.join(incoming, name), os.path.join(dest, name))
    # What the server no longer shares goes here too, files and line.
    gone = {i for i in rows if i not in shared}
    removed = len(gone)
    for i in gone:
        del rows[i]
    for name in os.listdir(dest):
        if FILE.match(name) and name.split(".", 1)[0] in gone:
            os.remove(os.path.join(dest, name))
    part = path + ".part"
    with open(part, "w") as f:
        for row in sorted(rows.values(), key=lambda r: (r.get("created_at") or "", r["id"])):
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(part, path)
    kinds = collections.Counter(r.get("kind") for r in rows.values())
    return new, updated, removed, len(rows), dict(kinds)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: python3 corpus_merge.py DEST INCOMING")
    new, updated, removed, total, kinds = merge(sys.argv[1], sys.argv[2])
    by_kind = ", ".join(f"{n} {k}" for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]))
    print(f"{new} new photos, {updated} updated, {removed} removed (no longer on the server); {total} in all ({by_kind}).")


if __name__ == "__main__":
    main()
