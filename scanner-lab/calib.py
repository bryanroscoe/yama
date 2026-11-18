"""Score a model on simulated captures of the held-out cards; compare with the real photos (bundle:
median 0.78, p10 0.65, >=0.82 36%). EMBED=<model>.onnx scores another embed graph (default the bundle's).
python <lab>/calib.py LEVEL N [SLEEVE_P]: N captures at roughness LEVEL, a share SLEEVE_P of them sleeved (default 0.75)."""
import sys, glob, os
import numpy as np, cv2
from paths import BUNDLE
from multiprocessing import Pool

def work(args):
    import onnxruntime as ort
    from sim import render
    from realeval import ROWS, COLS, scores_for, ill_rows
    global _s, _names, _row_of
    if "_s" not in globals():
        o = ort.SessionOptions(); o.intra_op_num_threads = 1
        _s = ort.InferenceSession(os.environ.get("EMBED", os.path.join(BUNDLE, "embed.onnx")), o, providers=["CPUExecutionProvider"])
        ID, NAME = COLS.index("id"), COLS.index("name")
        _names = np.array([r[NAME] for r in ROWS]); _row_of = {r[ID]: i for i, r in enumerate(ROWS)}
    f, seed, level, sleeve = args
    rng = np.random.default_rng(seed)
    i = _row_of[os.path.basename(f)[:-4]]
    card = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
    img, q, meta = render(card, rng, level, sleeve)
    rgba = np.ascontiguousarray(np.dstack([img, np.full(img.shape[:2], 255, np.uint8)]))
    s = scores_for(_s.run(None, {"scene": rgba, "quad": q})[0])
    ILL = COLS.index("illustration_id")
    right = float(s[ill_rows[ROWS[i][ILL]]].max()); wrong = float(s[_names != _names[i]].max())
    return right, wrong, meta["sleeved"]

if __name__ == "__main__":
    level = float(sys.argv[1]); n = int(sys.argv[2]); sleeve = float(sys.argv[3]) if len(sys.argv) > 3 else 0.75
    files = sorted(glob.glob("data/cards/*.jpg"))
    import hashlib
    # Only the cards training holds out (train.py's is_val), so a fine-tuned model is tested on cards it never saw.
    files = [f for f in files if int(hashlib.md5(os.path.basename(f)[:-4].encode()).hexdigest(), 16) % 25 == 0]
    rng = np.random.default_rng(123)
    pick = rng.choice(len(files), min(n, len(files)), replace=False)
    with Pool(6) as p:
        out = p.map(work, [(files[k], 1000 + j, level, sleeve) for j, k in enumerate(pick)], chunksize=4)
    a = np.array([(x, y) for x, y, _ in out]); sl = np.array([m for *_, m in out])
    def show(tag, b):
        if not len(b): return
        print(f"{tag:12s} n={len(b):4d} right median {np.median(b[:,0]):.3f} p10 {np.percentile(b[:,0],10):.3f} p90 {np.percentile(b[:,0],90):.3f}  top1 {(b[:,0]>b[:,1]).mean():.1%}  >=0.82 {(b[:,0]>=0.82).mean():.1%}  margin median {np.median(b[:,0]-b[:,1]):.3f}", flush=True)
    show(f"L={level}", a); show("  sleeved", a[sl]); show("  bare", a[~sl])
