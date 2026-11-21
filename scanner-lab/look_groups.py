"""Printing look data (LOOK.md): every artwork that several English paper printings share, from
Scryfall's bulk card data (the gzipped JSONL). Test: the artworks of the labelled real photos
(SCANNER_REAL_DIR's manifest.jsonl, `label_scryfall_id`). Train: every other artwork, less any whose
printings share a name with a test card (the card's, either face's, or the manifest's). A two-faced card
is grouped by its front face's artwork, as the lab embeds only fronts. Writes data/look_groups.json; the
bulk file is deleted after.
python <lab>/look_groups.py"""
import collections, gzip, json, os, urllib.request
from paths import REAL

UA = {"User-Agent": "YamaScannerLab/0.2", "Accept": "application/json"}
BULK = "data/default-cards.jsonl.gz"


def main():
    os.makedirs("data", exist_ok=True)
    if not os.path.exists(BULK):
        meta = json.load(urllib.request.urlopen(urllib.request.Request("https://api.scryfall.com/bulk-data/default-cards", headers=UA)))
        if not meta.get("jsonl_download_uri"):
            raise SystemExit("Scryfall's bulk metadata has no jsonl_download_uri: this script reads only the gzipped JSONL format.")
        urllib.request.urlretrieve(meta["jsonl_download_uri"], BULK + ".part")
        os.replace(BULK + ".part", BULK)
    rows = [json.loads(line) for line in open(f"{REAL}/manifest.jsonl")]
    labels = {r["label_scryfall_id"] for r in rows if r.get("label_scryfall_id")}
    # Every name a test card goes by (the card's, each face's, and what the manifest says), and every
    # name each artwork's printings go by: an artwork sharing any of them stays out of training.
    test_names = {r.get("label_name") for r in rows} - {None}
    groups, names = collections.defaultdict(list), collections.defaultdict(set)
    for line in gzip.open(BULK, "rt"):
        if not line.strip(): continue
        c = json.loads(line)
        if c.get("lang") != "en" or c.get("digital") or "paper" not in c.get("games", []): continue
        ill, uris = c.get("illustration_id"), c.get("image_uris")
        if (not ill or not uris) and c.get("card_faces"):
            f = c["card_faces"][0]; ill = ill or f.get("illustration_id"); uris = uris or f.get("image_uris")
        if not ill or not uris or not uris.get("normal"): continue
        groups[ill].append({"id": c["id"], "url": uris["normal"], "set": c["set"], "number": c["collector_number"]})
        card_names = {c["name"], *c["name"].split(" // "), *(f.get("name") for f in c.get("card_faces", []) if f.get("name"))}
        names[ill] |= card_names
        if c["id"] in labels: test_names |= card_names
    shared = {k: v for k, v in groups.items() if len(v) > 1}
    test_ills = {k for k, v in shared.items() if any(p["id"] in labels for p in v)}
    named = lambda k: bool(names[k] & test_names)
    train = [{"ill": k, "printings": v} for k, v in shared.items() if k not in test_ills and not named(k)]
    test = [{"ill": k, "printings": shared[k]} for k in sorted(test_ills)]
    json.dump({"train": train, "test": test}, open("data/look_groups.json", "w"))
    print(f"{len(shared)} shared artworks; train {len(train)} groups, {sum(len(g['printings']) for g in train)} printings; "
          f"test {len(test)} groups, {sum(len(g['printings']) for g in test)} printings")
    os.remove(BULK)


if __name__ == "__main__":
    main()
