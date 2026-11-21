"""Scryfall `normal` images of every printing in data/look_groups.json (test groups first) into
data/printings/<id>.jpg, eight a second at most, skipping what's there. Training input only: never
published. About 79,000 images, 7 GB, two hours (20 Nov 2026).
python <lab>/look_download.py"""
import json, os, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor


def main():
    d = json.load(open("data/look_groups.json"))
    todo = [p for g in d["test"] + d["train"] for p in g["printings"]]
    os.makedirs("data/printings", exist_ok=True)
    lock = threading.Lock(); last = [0.0]; done = [0]; failed = []

    def get(p):
        path = f"data/printings/{p['id']}.jpg"
        if os.path.exists(path): return
        with lock:
            wait = last[0] + 0.125 - time.time()
            if wait > 0: time.sleep(wait)
            last[0] = time.time()
        for attempt in range(4):
            try:
                req = urllib.request.Request(p["url"], headers={"User-Agent": "YamaScannerLab/0.2", "Accept": "image/*"})
                data = urllib.request.urlopen(req, timeout=30).read()
                open(path + ".part", "wb").write(data); os.replace(path + ".part", path); break
            except Exception as e:
                if getattr(e, "code", None) == 404: failed.append(p["id"]); return
                time.sleep(2 ** attempt * 2)
        else:
            failed.append(p["id"])
        with lock:
            done[0] += 1
            if done[0] % 1000 == 0: print(done[0], "downloaded", time.strftime("%H:%M:%S"), flush=True)

    print("starting", len(todo), time.strftime("%H:%M:%S"), flush=True)
    with ThreadPoolExecutor(4) as ex: list(ex.map(get, todo))
    print("finished; failed:", len(failed), failed[:10], flush=True)


if __name__ == "__main__":
    main()
