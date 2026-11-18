"""Safety sweep on whole simulated captures, as the phone scores them. sweep.py's simulated half
scores one crop per card (the cut for the card's own frame) against every gallery row; the phone
runs the whole embed graph and scores each row against the cut for that row's frame, so a capture
can also match wrongly through another frame's cut. This renders the held-out cards' captures
again (the same seeds gen.py used, so the same scenes), runs each through full embed graphs
(scene, quad -> 17 embeddings) and scores them like the search graph (realeval.scores_for).
python <lab>/fullsweep.py bundle/embed.onnx models/yama-art-YYYYMMDD.onnx [...]"""
import sys, os, glob, hashlib
import numpy as np, cv2
from multiprocessing import Pool

K = int(os.environ.get("K", 2))
RULES = [(a, m) for a in (0.60, 0.62, 0.65, 0.68, 0.70) for m in (0.06, 0.08, 0.10, 0.12, 0.14)] + [(0.82, 0.0)]


def init(models):
    global _sessions, _names, _row_of
    import onnxruntime as ort
    from realeval import ROWS, COLS
    o = ort.SessionOptions(); o.intra_op_num_threads = 1
    _sessions = [ort.InferenceSession(m, o, providers=["CPUExecutionProvider"]) for m in models]
    NAME, ID = COLS.index("name"), COLS.index("id")
    _names = np.array([r[NAME].split(" // ")[0] for r in ROWS]); _row_of = {r[ID]: i for i, r in enumerate(ROWS)}


def lead_stats(s, right_name):
    """(top, lead over the next different card, top is right) for known, and (top, lead) with the card hidden (sweep.py)."""
    order = np.argsort(-s)[:80]; top = order[0]
    other = next(s[i] for i in order if _names[i] != _names[top])
    known = (s[top], s[top] - other, _names[top] == right_name)
    s2 = s.copy(); s2[_names == right_name] = -3
    o2 = np.argsort(-s2)[:80]; t2 = o2[0]
    other2 = next(s2[i] for i in o2 if _names[i] != _names[t2])
    return known, (s2[t2], s2[t2] - other2)


def work(f):
    from sim import render
    from realeval import scores_for
    i = _row_of[os.path.basename(f)[:-4]]
    card = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
    out = []
    for k in range(K):
        rng = np.random.default_rng(i * 100 + k)  # gen.py's seed and draws
        level = rng.uniform(0.2, 2.0)
        img, q, meta = render(card, rng, level, 0.75)
        rgba = np.ascontiguousarray(np.dstack([img, np.full(img.shape[:2], 255, np.uint8)]))
        out.append([lead_stats(scores_for(s.run(None, {"scene": rgba, "quad": q})[0]), _names[i]) for s in _sessions])
    return out


def table(tag, k, u):
    print(f"\n== {tag}: whole captures, right {k[:, 2].mean():.1%} of {len(k)}")
    print("   rule (a, m)    locks right / wrong / unknown-locked")
    for a, m in RULES:
        lk = (k[:, 0] >= a) & (k[:, 1] >= m)
        print(f"   a>={a:.2f} m>={m:.2f}   {(lk & (k[:, 2] == 1)).mean():6.1%} / {int((lk & (k[:, 2] == 0)).sum()):3d} / {int(((u[:, 0] >= a) & (u[:, 1] >= m)).sum()):4d} of {len(u)}", flush=True)


if __name__ == "__main__":
    models = sys.argv[1:]
    from realeval import ROWS, COLS
    ID = COLS.index("id")
    # The cards train.py held out (is_val): the id's md5 % 25 is 0.
    files = [f for f in sorted(glob.glob("data/cards/*.jpg")) if int(hashlib.md5(os.path.basename(f)[:-4].encode()).hexdigest(), 16) % 25 == 0]
    with Pool(int(os.environ.get("PROCS", 6)), initializer=init, initargs=(models,)) as p:
        results = [c for card in p.imap(work, files, chunksize=4) for c in card]
    for j, m in enumerate(models):
        k = np.array([r[j][0] for r in results], dtype=float); u = np.array([r[j][1] for r in results], dtype=float)
        table(m, k, u)
