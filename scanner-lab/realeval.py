"""Score the pinned art model on real scan photos, with optional preprocessing variants.
Also the gallery, the artwork index and the photo labels the other scripts import.
Usage: realeval.py DATA_DIR [variant ...]"""
import json, os, sqlite3, sys, time
import numpy as np, cv2, onnx, onnxruntime as ort
from onnx import numpy_helper
from paths import BUNDLE as B, db_uri

def load_gallery():
    m = onnx.load(f"{B}/search.onnx")
    init = {t.name: numpy_helper.to_array(t) for t in m.graph.initializer}
    return init["gallery"].astype(np.float32), init["frames"].reshape(-1).astype(np.int64), init["penalties"].astype(np.float32)

GAL, FRAMES, PEN = load_gallery()
ARTS = json.load(open(f"{B}/arts.slim.json"))
COLS = ARTS["columns"]; ROWS = ARTS["rows"]
ILL = COLS.index("illustration_id")
ill_rows = {}
for i, r in enumerate(ROWS): ill_rows.setdefault(r[ILL], []).append(i)
EMBED = ort.InferenceSession(f"{B}/embed.onnx", providers=["CPUExecutionProvider"])

def scores_for(emb):  # emb F x 128 -> N scores, same formula as search.onnx
    s = np.einsum("nd,nd->n", GAL, emb[FRAMES]) - PEN
    return s

def embed(rgb, quad):
    rgba = np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)])
    return EMBED.run(None, {"scene": np.ascontiguousarray(rgba), "quad": np.asarray(quad, np.float32)})[0]

def card_mask(shape, quad):
    m = np.zeros(shape[:2], np.uint8); cv2.fillConvexPoly(m, np.asarray(quad, np.int32), 1); return m.astype(bool)

def gray_world(rgb, quad):
    m = card_mask(rgb.shape, quad); px = rgb[m].astype(np.float32)
    means = px.mean(0); g = means.mean()
    out = rgb.astype(np.float32) * (g / np.maximum(means, 1))
    return np.clip(out, 0, 255).astype(np.uint8)

def stretch(rgb, quad, lo=1, hi=99):
    m = card_mask(rgb.shape, quad); out = np.empty_like(rgb, dtype=np.float32)
    for c in range(3):
        a, b = np.percentile(rgb[..., c][m], [lo, hi]); out[..., c] = (rgb[..., c] - a) * 255.0 / max(b - a, 1)
    return np.clip(out, 0, 255).astype(np.uint8)

def antialias(rgb, quad, target=350):
    q = np.asarray(quad, np.float32)
    h = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
    f = target / h
    if f >= 1: return rgb, quad
    small = cv2.resize(rgb, (round(rgb.shape[1] * f), round(rgb.shape[0] * f)), interpolation=cv2.INTER_AREA)
    return small, (q * f).tolist()

def blur(rgb, quad, s=1.0):
    return cv2.GaussianBlur(rgb, (0, 0), s)

VARIANTS = {
    "base": lambda im, q: (im, q),
    "aa": lambda im, q: antialias(im, q),
    "wb": lambda im, q: (gray_world(im, q), q),
    "stretch": lambda im, q: (stretch(im, q), q),
    "blur1": lambda im, q: (blur(im, q, 1.0), q),
    "wb+aa": lambda im, q: antialias(gray_world(im, q), q),
    "stretch+aa": lambda im, q: antialias(stretch(im, q), q),
    "wb+stretch+aa": lambda im, q: antialias(stretch(gray_world(im, q), q), q),
}

def labels(data_dir):
    db = sqlite3.connect(db_uri(), uri=True)
    out = []
    for l in open(f"{data_dir}/manifest.jsonl"):
        r = json.loads(l)
        ill = None
        if r.get("label_scryfall_id"):
            row = db.execute("SELECT illustration_id FROM printings WHERE scryfall_id = ?", (r["label_scryfall_id"],)).fetchone()
            ill = row and row[0]
        if not ill and r["kind"] == "added": ill = r.get("guess_illustration_id")
        if not ill or ill not in ill_rows or not r.get("quad"): continue
        out.append((r, ill))
    return out

def main():
    data_dir = sys.argv[1]; names = sys.argv[2:] or list(VARIANTS)
    items = labels(data_dir)
    print(f"{len(items)} labelled photos with a known artwork")
    res = {}
    for name in names:
        per = []
        for r, ill in items:
            bgr = cv2.imread(f"{data_dir}/{r['id']}.jpg"); rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            im, q = VARIANTS[name](rgb, json.loads(r["quad"]))
            s = scores_for(embed(im, q))
            right = max(s[i] for i in ill_rows[ill])
            mask = np.ones_like(s, bool); mask[ill_rows[ill]] = False
            wrong = s[mask].max()
            per.append((r["id"], float(right), float(wrong), r["score"]))
        a = np.array([[p[1], p[2]] for p in per])
        top1 = (a[:, 0] > a[:, 1]).mean()
        lock1 = (a[:, 0] >= 0.82).mean(); lock2 = ((a[:, 0] >= 0.62) & (a[:, 0] > a[:, 1])).mean()
        wrong_hi = ((a[:, 1] > a[:, 0]) & (a[:, 1] >= 0.62)).sum()
        print(f"{name:16s} top1 {top1:6.1%}  right median {np.median(a[:,0]):.3f} p10 {np.percentile(a[:,0],10):.3f}  best-wrong median {np.median(a[:,1]):.3f}  margin median {np.median(a[:,0]-a[:,1]):.3f}  >=0.82 {lock1:6.1%}  wrong-on-top>=0.62 {wrong_hi}")
        res[name] = per
    os.makedirs("out", exist_ok=True)
    json.dump(res, open(f"out/realeval-{data_dir.rstrip('/').split('/')[-1]}.json", "w"))

if __name__ == "__main__":
    main()
