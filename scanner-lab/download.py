"""Download Scryfall 'normal' card images for the picked rows, politely (4 threads, ~8 req/s)."""
import json, os, sys, time, threading, urllib.request
from concurrent.futures import ThreadPoolExecutor
from realeval import ROWS, COLS
ID = COLS.index("id")
rows = json.load(open("data/train_rows.json"))["rows"]
os.makedirs("data/cards", exist_ok=True)
lock = threading.Lock(); last = [0.0]; done = [0]; failed = []
def url(sid):
    back = sid.endswith("-1"); sid = sid.removesuffix("-1")
    return f"https://cards.scryfall.io/normal/{'back' if back else 'front'}/{sid[0]}/{sid[1]}/{sid}.jpg", sid + ("-1" if back else "")
def get(i):
    u, name = url(ROWS[i][ID]); path = f"data/cards/{name}.jpg"
    if os.path.exists(path): return
    with lock:
        wait = last[0] + 0.125 - time.time()
        if wait > 0: time.sleep(wait)
        last[0] = time.time()
    for attempt in range(4):
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "YamaScannerLab/0.1", "Accept": "image/*"})
            data = urllib.request.urlopen(req, timeout=30).read()
            open(path + ".part", "wb").write(data); os.replace(path + ".part", path); break
        except Exception as e:
            if getattr(e, "code", None) == 404: failed.append(name); return
            time.sleep(2 ** attempt * 2)
    else: failed.append(name)
    with lock:
        done[0] += 1
        if done[0] % 1000 == 0: print(done[0], "downloaded", time.strftime("%H:%M:%S"), flush=True)
with ThreadPoolExecutor(4) as ex: list(ex.map(get, rows))
print("finished; failed:", len(failed), failed[:10], flush=True)
