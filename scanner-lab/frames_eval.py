"""Card finders on cards with strong lines inside their frame (fetch_frames.py; the held-out half, md5 % 2 == 0),
alone on a table and on 2 others (pile.py), 2 frames each: the outline's error against the card whichever way
round, and how often its outline isn't card-shaped (cardShape.ts's "junk"), by layout.
python <lab>/frames_eval.py FRAMES_DIR DET.onnx [DET2.onnx ...]   (from the work directory; PROCS (6))"""
import sys, os, json, glob, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, cv2
from multiprocessing import Pool
import corners_eval as ce
import pile
import pile_eval as pe


def held(i):
    return int(hashlib.md5(i.encode()).hexdigest(), 16) % 2 == 0


def init(dets, frames):
    global DETS, CARDS, FRAMES, META
    DETS = [ce.sess(d) for d in dets]
    CARDS = sorted(glob.glob("data/cards/*.jpg"))
    FRAMES = frames
    META = json.load(open(frames.rstrip("/") + ".json"))


def work(cid):
    rd = lambda p: cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB)
    out = []
    for n in (0, 2):
        for k in range(2):
            rng = np.random.default_rng([int(hashlib.md5(cid.encode()).hexdigest(), 16) % 10**8, n, k])
            under = [rd(p) for p in pile.draw_under(rng, CARDS, n=n)]
            img, truth, _ = pile.render_pile(rd(f"{FRAMES}/{cid}.jpg"), under, rng, rng.uniform(0.2, 2.0))
            rgba = np.ascontiguousarray(np.dstack([img, np.full(img.shape[:2], 255, np.uint8)]))
            row = {"id": cid, "kind": META[cid]["kind"], "n": n}
            for j, det in enumerate(DETS):
                q, _ = ce.identify(det, rgba)
                row[j] = None if q is None else (pe.err_any(np.asarray(q), truth), pe.outline_kind(q))
            out.append(row)
    return out


if __name__ == "__main__":
    frames, dets = sys.argv[1], sys.argv[2:]
    meta = json.load(open(frames.rstrip("/") + ".json"))
    ids = [i for i in meta if held(i)]
    with Pool(int(os.environ.get("PROCS", 6)), initializer=init, initargs=(dets, frames)) as p:
        rows = [x for c in p.imap(work, ids) for x in c]
    for kind in sorted({r["kind"] for r in rows}) + ["all"]:
        for n in (0, 2):
            rs = [r for r in rows if (kind == "all" or r["kind"] == kind) and r["n"] == n]
            line = []
            for j, d in enumerate(dets):
                e = np.array([r[j][0] if r[j] else 1.0 for r in rs])
                junk = np.mean([bool(r[j]) and r[j][1] == "junk" for r in rs])
                line.append(f"{os.path.basename(d)}: median {np.median(e):.1%} within5 {np.mean(e <= .05):.0%} within10 {np.mean(e <= .1):.0%} junk {junk:.0%}")
            print(f"{kind:9s} {n} under ({len(rs):3d}) | " + " | ".join(line))
