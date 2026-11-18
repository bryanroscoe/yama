"""Evaluate a query embedder (torch, takes normalised 128x128 crops) on the real photos:
right-card rate, scores, margins, lock rules, and the unknown-card test. Real crops are cached
in data/real_crops.npz (delete it after changing the photo set)."""
import sys, os, json
import numpy as np, torch
from paths import REAL
from realeval import labels, ROWS, COLS, GAL, FRAMES, PEN, ill_rows

NAME = COLS.index("name")
NAMES = np.array([r[NAME].split(" // ")[0] for r in ROWS])

def real_crops():
    path = "data/real_crops.npz"
    if os.path.exists(path):
        z = np.load(path, allow_pickle=True); return z["crops"], list(z["ills"])
    import cv2, onnxruntime as ort
    front = ort.InferenceSession("models/front.onnx", providers=["CPUExecutionProvider"])
    crops, ills = [], []
    for r, ill in labels(REAL):
        rgb = cv2.cvtColor(cv2.imread(f"{REAL}/{r['id']}.jpg"), cv2.COLOR_BGR2RGB)
        rgba = np.ascontiguousarray(np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)]))
        crops.append(front.run(None, {"scene": rgba, "quad": np.asarray(json.loads(r["quad"]), np.float32)})[0]); ills.append(ill)
    crops = np.stack(crops).astype(np.float16)
    os.makedirs("data", exist_ok=True)
    np.savez(path, crops=crops, ills=np.array(ills)); return crops, ills

def scores(emb):
    return np.einsum("nd,nd->n", GAL, emb[FRAMES]) - PEN

@torch.no_grad()
def evaluate(model, device="cpu", verbose=True):
    crops, ills = real_crops()
    model.eval()
    recs, unk = [], []
    for c, ill in zip(crops, ills):
        e = model(torch.from_numpy(c.astype(np.float32)).to(device)).float().cpu().numpy()
        s = scores(e)
        right_name = NAMES[ill_rows[ill][0]]
        order = np.argsort(-s)[:60]; top = order[0]
        other = next(s[i] for i in order if NAMES[i] != NAMES[top])
        recs.append((float(s[ill_rows[ill]].max()), float(s[NAMES != right_name].max()), float(s[top]), float(s[top] - other), NAMES[top] == right_name))
        s2 = s.copy(); s2[NAMES == right_name] = -3
        o2 = np.argsort(-s2)[:60]; t2 = o2[0]
        other2 = next(s2[i] for i in o2 if NAMES[i] != NAMES[t2])
        unk.append((float(s2[t2]), float(s2[t2] - other2)))
    a = np.array(recs, dtype=object); right = a[:, 0].astype(float); wrong = a[:, 1].astype(float)
    top = a[:, 2].astype(float); lead = a[:, 3].astype(float); ok = a[:, 4].astype(bool)
    u = np.array(unk)
    res = {
        "top1": ok.mean(), "right_median": np.median(right), "right_p10": np.percentile(right, 10),
        "wrong_median": np.median(wrong), "gap_median": np.median(right - wrong),
        "lock_082": ((top >= 0.82) & ok).mean(), "lock_082_wrong": int(((top >= 0.82) & ~ok).sum()),
        "lock_lead": ((top >= 0.65) & (lead >= 0.10) & ok).mean(), "lock_lead_wrong": int(((top >= 0.65) & (lead >= 0.10) & ~ok).sum()),
        "unknown_top_median": np.median(u[:, 0]), "unknown_top_max": u[:, 0].max(), "unknown_lead_max": u[:, 1].max(),
        "unknown_locks_082": int((u[:, 0] >= 0.82).sum()), "unknown_locks_lead": int(((u[:, 0] >= 0.65) & (u[:, 1] >= 0.10)).sum()),
    }
    if verbose:
        print("  real: top1 {top1:.1%}  right median {right_median:.3f} p10 {right_p10:.3f}  best-wrong median {wrong_median:.3f}  gap {gap_median:.3f}  "
              "lock@0.82 {lock_082:.1%} (wrong {lock_082_wrong})  lock lead {lock_lead:.1%} (wrong {lock_lead_wrong})  "
              "unknown: top median {unknown_top_median:.3f} max {unknown_top_max:.3f} lead max {unknown_lead_max:.3f} "
              "locks@0.82 {unknown_locks_082} locks lead {unknown_locks_lead}".format(**res), flush=True)
    return res

if __name__ == "__main__":
    from model import load_bundle_embedder
    evaluate(load_bundle_embedder())
