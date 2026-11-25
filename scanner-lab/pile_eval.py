"""Card finders on piles (pile.py): a held-out card tossed onto 0 to 8 others, as the scanner finds it
(corners_eval.py's port of identify()'s coarse and fine passes), then the art model and the lead rule.
Per frame and finder: found (a card in view: vote 0.5, short side 60 px, cardDetail 4), the corner error
over the top card's short side as printed (`err`) and whichever way round (`err_any`: the outline's own
fit), the outline's kind as cardShape.ts judges it (card, squat, junk), and the art read at those corners
(right card first; the lead rule's lock, right or wrong).
python <lab>/pile_eval.py OUT.json DET.onnx [DET2.onnx ...]   (from the work directory; 'bundle' is the
bundle's detector.onnx. Env: EMBED, SIMS (300 held-out cards), K (2 frames each), PROCS (6), SEED (0))"""
import sys, os, glob, json, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, cv2
from multiprocessing import Pool
import corners_eval as ce
import pile

SHAPE_MIN, SHAPE_MAX, MIN_ANGLE = 1.1, 1.8, 55.0


def outline_kind(q):
    """cardShape.ts's outlineKind: "card", "squat" (one card tilted until it looks square) or "junk"."""
    q = np.asarray(q, np.float64)
    side = lambda i: np.linalg.norm(q[(i + 1) % 4] - q[i])
    a, b = (side(0) + side(2)) / 2, (side(1) + side(3)) / 2
    ratio = max(a, b) / max(min(a, b), 1e-6)
    angles, cross = [], []
    for i in range(4):
        v1, v2 = q[(i + 3) % 4] - q[i], q[(i + 1) % 4] - q[i]
        c = np.dot(v1, v2) / max(np.linalg.norm(v1) * np.linalg.norm(v2), 1e-9)
        angles.append(np.degrees(np.arccos(np.clip(c, -1, 1))))
        cross.append(v2[0] * v1[1] - v2[1] * v1[0])
    convex = all(c > 0 for c in cross) or all(c < 0 for c in cross)
    if not convex or min(angles) < MIN_ANGLE or ratio > SHAPE_MAX:
        return "junk"
    return "squat" if ratio < SHAPE_MIN else "card"


def err_any(q, truth):
    return min(ce.corner_err(np.roll(q, k, 0), truth) for k in range(4))


def frame(f, k, cards):
    seed = int(os.environ.get("SEED", 0))
    i = int(hashlib.md5(os.path.basename(f)[:-4].encode()).hexdigest(), 16) % 10**8
    rng = np.random.default_rng([seed, i, k])
    rd = lambda p: cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB)
    under = [rd(p) for p in pile.draw_under(rng, cards)]
    img, truth, meta = pile.render_pile(rd(f), under, rng, rng.uniform(0.2, 2.0))
    return np.ascontiguousarray(np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])), truth, meta


def work(f):
    out = []
    for k in range(int(os.environ.get("K", 2))):
        rgba, truth, meta = frame(f, k, CARDS)
        right = ce.NAMES[ce.ROW[os.path.basename(f)[:-4]]]
        row = {"card": os.path.basename(f)[:-4], "k": k, **meta}
        for j, det in enumerate(ce.DETS):
            q, vote = ce.identify(det, rgba)
            if q is not None and ce_detail(rgba, q) < 4:
                q = None
            if q is None:
                row[j] = {"found": False, "lock": False, "top_right": False}
                continue
            row[j] = {"found": True, "err": ce.corner_err(q, truth), "err_any": err_any(q, truth), "kind": outline_kind(q), **ce.lead(rgba, q, right)}
        out.append(row)
    return out


def ce_detail(rgba, q):
    """recognizer.ts's cardDetail: the mean step between neighbouring 5 x 5 averages of a 32 x 44 grid."""
    a, b, c, d = np.asarray(q, np.float64)
    lum = (0.299 * rgba[..., 0] + 0.587 * rgba[..., 1] + 0.114 * rgba[..., 2]).astype(np.float64)
    box = cv2.blur(lum, (5, 5), borderType=cv2.BORDER_REPLICATE)
    v = (0.05 + 0.9 * np.arange(44) / 43)[:, None]; u = (0.05 + 0.9 * np.arange(32) / 31)[None, :]
    x = (1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0])
    y = (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1])
    g = box[np.clip(np.round(y).astype(int), 0, lum.shape[0] - 1), np.clip(np.round(x).astype(int), 0, lum.shape[1] - 1)]
    return float((np.abs(np.diff(g, axis=1)).sum() + np.abs(np.diff(g, axis=0)).sum()) / (44 * 31 + 43 * 32))


def init(dets):
    global CARDS
    ce.init(dets)
    CARDS = sorted(glob.glob("data/cards/*.jpg"))


def summarise(rows, dets):
    groups = [("on the table (0 under)", lambda r: r["under"] == 0), ("on 1 or 2", lambda r: 1 <= r["under"] <= 2), ("on 3 or more", lambda r: r["under"] >= 3), ("all", lambda r: True)]
    lines = []
    for tag, keep in groups:
        rs = [r for r in rows if keep(r)]
        if not rs:
            continue
        lines.append(f"\n== {tag} ({len(rs)} frames)")
        for j, d in enumerate(dets):
            x = [r[str(j)] if str(j) in r else r[j] for r in rs]
            f = [y for y in x if y["found"]]
            e = np.array([y["err_any"] for y in f]) if f else np.array([1.0])
            kinds = {k: sum(y.get("kind") == k for y in f) / len(rs) for k in ("card", "squat", "junk")}
            lines.append(
                f"  {d}: found {len(f) / len(rs):.1%}; outline within 5% {np.sum(e <= 0.05) / len(rs):.1%}, within 10% {np.sum(e <= 0.10) / len(rs):.1%} "
                f"(median {np.median(e):.1%}, p90 {np.percentile(e, 90):.1%}); card {kinds['card']:.1%} squat {kinds['squat']:.1%} junk {kinds['junk']:.1%}; "
                f"right card first {np.mean([y['top_right'] for y in x]):.1%}, lead lock right {np.mean([y['lock'] and y['top_right'] for y in x]):.1%} "
                f"(card-shaped {np.mean([y['lock'] and y['top_right'] and y.get('kind') == 'card' for y in x]):.1%}), wrong {sum(y['lock'] and not y['top_right'] for y in x)}")
    return "\n".join(lines)


if __name__ == "__main__":
    out, dets = sys.argv[1], sys.argv[2:]
    files = [f for f in sorted(glob.glob("data/cards/*.jpg")) if int(hashlib.md5(os.path.basename(f)[:-4].encode()).hexdigest(), 16) % 25 == 0]
    files = files[: int(os.environ.get("SIMS", 300))]
    with Pool(int(os.environ.get("PROCS", 6)), initializer=init, initargs=(dets,)) as p:
        rows = [x for c in p.imap(work, files, chunksize=2) for x in c]
    json.dump({"dets": dets, "rows": rows}, open(out, "w"))
    print(summarise(rows, dets))
