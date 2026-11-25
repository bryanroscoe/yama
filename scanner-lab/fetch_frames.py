"""Scryfall 'normal' fronts of cards with strong lines inside their frame, one per artwork, for training and
testing the card finder on them (README.md, "The card finder on piles"): Sagas, Classes, Cases, split cards,
adventures and flip cards. Politely: one request at a time, ~8 a second. Writes OUT/<scryfall id>.jpg and
OUT.json (id -> layout and name). Card images are Scryfall's: never published, delete them when done.
python <lab>/fetch_frames.py OUT_DIR"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

QUERIES = {"saga": "layout:saga", "class": "layout:class", "case": "layout:case", "split": "layout:split -is:digital",
           "adventure": "layout:adventure", "flip": "layout:flip"}
CAP = {"saga": 160, "class": 40, "case": 30, "split": 80, "adventure": 60, "flip": 20}
HEADERS = {"User-Agent": "YamaScannerLab/0.1"}
last = 0.0


def get(url, accept):
    global last
    wait = 0.12 - (time.time() - last)
    if wait > 0:
        time.sleep(wait)
    last = time.time()
    with urllib.request.urlopen(urllib.request.Request(url, headers={**HEADERS, "Accept": accept}), timeout=30) as r:
        return r.read()


def main(out):
    os.makedirs(out, exist_ok=True)
    got = {}
    for kind, q in QUERIES.items():
        url = "https://api.scryfall.com/cards/search?" + urllib.parse.urlencode({"q": q + " lang:en", "unique": "art", "order": "released"})
        n = 0
        while url and n < CAP[kind]:
            try:
                page = json.loads(get(url, "application/json"))
            except urllib.error.HTTPError as e:
                if e.code == 404:  # no card matches
                    break
                raise
            for c in page["data"]:
                if n >= CAP[kind]:
                    break
                img = (c.get("image_uris") or (c.get("card_faces") or [{}])[0].get("image_uris") or {}).get("normal")
                if not img:
                    continue
                path = os.path.join(out, f"{c['id']}.jpg")
                if not os.path.exists(path):
                    with open(path, "wb") as f:
                        f.write(get(img, "image/*"))
                got[c["id"]] = {"kind": kind, "name": c["name"]}
                n += 1
            url = page.get("next_page") if page.get("has_more") else None
        print(kind, n, flush=True)
    with open(out.rstrip("/") + ".json", "w") as f:
        json.dump(got, f)


if __name__ == "__main__":
    main(sys.argv[1])
