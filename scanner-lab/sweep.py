"""Safety sweep: for the bundle's model and each checkpoint, the share of known cards a lock rule
settles (right) and the share of unknown cards (their name hidden from the gallery) it would settle
as some other card. On the real photos (124) and the held-out simulated crops (train.py's val split).
python <lab>/sweep.py runs/art1 [bundle] [ep6.pt ...]"""
import sys, os, glob, hashlib
import numpy as np, torch, cv2
from model import load_bundle_embedder
from evalreal import real_crops, scores, NAMES
from realeval import ROWS, COLS, GAL, PEN, ill_rows
from crops_ds import Crops

ID = COLS.index("id")
RULES = [(a, m) for a in (0.60, 0.62, 0.65, 0.68, 0.70) for m in (0.06, 0.08, 0.10, 0.12, 0.14)] + [(0.82, 0.0)]


def lead_stats(s, right_name):
    """(top, lead over the next different card, top is right) for known, and (top, lead) with the card hidden."""
    order = np.argsort(-s)[:80]; top = order[0]
    other = next(s[i] for i in order if NAMES[i] != NAMES[top])
    known = (s[top], s[top] - other, NAMES[top] == right_name)
    s2 = s.copy(); s2[NAMES == right_name] = -3
    o2 = np.argsort(-s2)[:80]; t2 = o2[0]
    other2 = next(s2[i] for i in o2 if NAMES[i] != NAMES[t2])
    return known, (s2[t2], s2[t2] - other2)


@torch.no_grad()
def collect(model):
    model.eval()
    crops, ills = real_crops()
    real_k, real_u = [], []
    for c, ill in zip(crops, ills):
        e = model(torch.from_numpy(c.astype(np.float32))).numpy()
        k, u = lead_stats(scores(e), NAMES[ill_rows[ill][0]])
        real_k.append(k); real_u.append(u)
    files = sorted(glob.glob("data/crops/*.jpg"))
    val = [(f, int(os.path.basename(f).split("_")[0])) for f in files]
    val = [it for it in val if int(hashlib.md5(ROWS[it[1]][ID].encode()).hexdigest(), 16) % 25 == 0]
    ds = Crops(val, False)
    sim_k, sim_u = [], []
    for start in range(0, len(ds), 256):
        batch = [ds[i] for i in range(start, min(start + 256, len(ds)))]
        x = torch.stack([b[0] for b in batch]); rows = [b[1] for b in batch]
        E = model(x).numpy()
        S = E @ GAL.T - PEN  # one crop per card: the same embedding for every row's frame
        for s, row in zip(S, rows):
            k, u = lead_stats(s, NAMES[row]); sim_k.append(k); sim_u.append(u)
    return np.array(real_k, dtype=float), np.array(real_u, dtype=float), np.array(sim_k, dtype=float), np.array(sim_u, dtype=float)


def table(tag, rk, ru, sk, su):
    print(f"\n== {tag}: real right {rk[:, 2].mean():.1%}  sim right {sk[:, 2].mean():.1%}")
    print("   rule (a, m)    real locks right / wrong / unknown-locked     sim locks right / wrong / unknown-locked")
    for a, m in RULES:
        def rate(k, u):
            lk = (k[:, 0] >= a) & (k[:, 1] >= m)
            return (lk & (k[:, 2] == 1)).mean(), int((lk & (k[:, 2] == 0)).sum()), int(((u[:, 0] >= a) & (u[:, 1] >= m)).sum())
        r = rate(rk, ru); s = rate(sk, su)
        print(f"   a>={a:.2f} m>={m:.2f}   {r[0]:6.1%} / {r[1]:2d} / {r[2]:3d} of {len(ru)}      {s[0]:6.1%} / {s[1]:3d} / {s[2]:4d} of {len(su)}")


if __name__ == "__main__":
    run = sys.argv[1]
    models = [("bundle", None)] + [(os.path.basename(p), p) for p in sorted(glob.glob(f"{run}/ep*.pt"))]
    only = sys.argv[2:]
    for tag, path in models:
        if only and tag not in only: continue
        m = load_bundle_embedder()
        if path: m.load_state_dict(torch.load(path, map_location="cpu"))
        table(tag, *collect(m))
