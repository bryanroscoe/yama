"""Printing look training data, cut exactly as the exported graph cuts (look_crops.py):
- data/pk2/<id>.jpg: each printing's clean set-symbol patch, from its Scryfall `normal` image and corners;
- data/pq2/<id>_<k>.jpg: K simulated phone captures of it (sim.render, at the recogniser's 640 px), cut
  to the symbol patch at the capture's noisy quad, as the phone would cut it.
Run again to finish (it skips what exists). Writes data/look_gen.json: the code and library versions
that made the crops, which look_train.py records with each run. About 1.9 GB for 78,700 printings, two to three hours on
5 cores (20 Nov 2026). python <lab>/look_gen.py   (K=2, WORKERS=5)"""
import glob, hashlib, json, os, time
import numpy as np, cv2
from multiprocessing import Pool

K = int(os.environ.get("K", 2))


def work(f):
    from sim import render
    from look_crops import symbol_patch, corners
    pid = os.path.basename(f)[:-4]
    card = None
    kp = f"data/pk2/{pid}.jpg"
    if not os.path.exists(kp):
        card = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
        cv2.imwrite(kp + ".part.jpg", cv2.cvtColor(symbol_patch(card, corners(card)), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
        os.replace(kp + ".part.jpg", kp)
    for k in range(K):
        out = f"data/pq2/{pid}_{k}.jpg"
        if os.path.exists(out): continue
        if card is None: card = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
        rng = np.random.default_rng(int(pid[:8], 16) * 10 + k + 7)
        img, q, _ = render(card, rng, rng.uniform(0.2, 1.8), 0.75)
        cv2.imwrite(out + ".part.jpg", cv2.cvtColor(symbol_patch(img, q), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        os.replace(out + ".part.jpg", out)
    return 1


def main():
    os.makedirs("data/pq2", exist_ok=True); os.makedirs("data/pk2", exist_ok=True)
    d = json.load(open("data/look_groups.json"))
    ids = {p["id"] for g in d["train"] + d["test"] for p in g["printings"]}
    files = [f for f in sorted(glob.glob("data/printings/*.jpg")) if os.path.basename(f)[:-4] in ids]
    with Pool(int(os.environ.get("WORKERS", 5))) as p:
        for n, _ in enumerate(p.imap_unordered(work, files, chunksize=8)):
            if n % 5000 == 0: print(n, "printings", flush=True)
    lab = os.path.dirname(os.path.abspath(__file__))
    code = {f: hashlib.sha256(open(os.path.join(lab, f), "rb").read()).hexdigest() for f in ("look_gen.py", "look_crops.py", "sim.py")}
    json.dump({"k": K, "printings": len(files), "code_sha256": code, "opencv": cv2.__version__, "numpy": np.__version__,
               "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, open("data/look_gen.json", "w"), indent=1)
    print("done", len(files), flush=True)


if __name__ == "__main__":
    main()
