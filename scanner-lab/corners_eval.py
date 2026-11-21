"""Compare detectors as the scanner runs them: recognizer.ts's coarse and fine passes (ported here), then the
art model (17 cuts) and the lead rule (top >= 0.65, >= 0.10 ahead of another card).
- window: the held-out validation windows (corner error / the card's short side; presence)
- sim: held-out cards (fullsweep's scenes) in a 640 x 1138 frame, half with fingers over corners or a thumb
- real: Bryan's photos (the phone's quad is the bundle's detector, so it isn't ground truth there)
python <lab>/corners_eval.py DET.onnx [DET2.onnx ...]   (from the work directory; 'bundle' is the bundle's detector.onnx)
Env: EMBED (the art model, default models/yama-art-20261118.onnx), CORNERS_DATA (data/corners), SIMS (400), PROCS (4),
WINDOWS=0 to skip the validation windows."""
import sys, os, glob, json, hashlib
import numpy as np, cv2, onnxruntime as ort
from paths import BUNDLE, REAL
from multiprocessing import Pool

C = json.load(open(f"{BUNDLE}/manifest.json"))["constants"]
W, H = 640, 1138
EMBED = os.environ.get("EMBED", "models/yama-art-20261118.onnx")
DATA = os.environ.get("CORNERS_DATA", "data/corners")


def sess(p):
    o = ort.SessionOptions(); o.intra_op_num_threads = 1
    return ort.InferenceSession(f"{BUNDLE}/detector.onnx" if p == "bundle" else p, o, providers=["CPUExecutionProvider"])


def detect(det, rgba, cx, cy, side):
    size = C["det_input"]; k = size / side
    M = np.float32([[k, 0, size / 2 - k * cx], [0, k, size / 2 - k * cy]])
    win = cv2.warpAffine(rgba, M, (size, size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    q, up, c, sh = det.run(None, {"window": np.ascontiguousarray(win)})
    to = lambda p: (np.asarray(p) - size / 2) / k + [cx, cy]
    return {"quad": to(q), "vote": float(np.hypot(*up)) / C["rotations"], "centre": to(c), "short": float(sh) * side / size}


def identify(det, rgba):
    h, w = rgba.shape[:2]
    coarse = detect(det, rgba, w / 2, h / 2, C["scene"])
    if coarse["vote"] < 0.25 and max(w, h) > C["scene"] * 1.1:
        coarse = detect(det, rgba, w / 2, h / 2, max(w, h))
    if coarse["vote"] < 0.25:
        return None, coarse["vote"]
    side = max(coarse["short"] * C["card_aspect"] / C["refine_fill"], C["refine_min_side"])
    fine = detect(det, rgba, *coarse["centre"], side)
    q = fine["quad"]
    short = min(np.linalg.norm(np.roll(q, -1, 0) - q, axis=1))
    return (q if fine["vote"] >= 0.5 and short >= 60 else None), fine["vote"]


def corner_err(q, truth):
    """Mean corner distance over the card's short side; the order as printed counts (a turned quad is wrong)."""
    side = min(np.linalg.norm(truth[1] - truth[0]), np.linalg.norm(truth[2] - truth[1]))
    return float(np.linalg.norm(q - truth, axis=1).mean() / side)


def init(dets):
    global DETS, EMB, NAMES, ROW, scores_for
    from realeval import ROWS, COLS, scores_for as sf
    scores_for = sf
    DETS = [sess(d) for d in dets]
    o = ort.SessionOptions(); o.intra_op_num_threads = 1
    EMB = ort.InferenceSession(EMBED, o, providers=["CPUExecutionProvider"])
    NAMES = np.array([r[COLS.index("name")].split(" // ")[0] for r in ROWS]); ROW = {r[COLS.index("id")]: i for i, r in enumerate(ROWS)}


def lead(rgba, q, right):
    s = scores_for(EMB.run(None, {"scene": rgba, "quad": q.astype(np.float32)})[0])
    order = np.argsort(-s)[:80]; top = order[0]
    other = next(s[j] for j in order if NAMES[j] != NAMES[top])
    lock = s[top] >= 0.65 and s[top] - other >= 0.10
    return {"top_right": bool(NAMES[top] == right), "lock": bool(lock), "score": float(s[top])}


def sim_frame(f, k):
    import sim
    from corners_gen import add_fingers
    i = ROW[os.path.basename(f)[:-4]]
    rng = np.random.default_rng(i * 100 + k)  # fullsweep's scenes
    img, _, meta = sim.render(cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB), rng, rng.uniform(0.2, 2.0), 0.75)
    truth = np.float32(meta["card_quad"])
    r2 = np.random.default_rng(i * 100 + k + 7)
    sh, sw = img.shape[:2]
    s = r2.uniform(0.6, 0.85) * W / sw
    card = cv2.resize(img, (int(sw * s), int(sh * s)), interpolation=cv2.INTER_AREA)
    frame = cv2.resize(cv2.GaussianBlur(img, (0, 0), 25), (W, H))
    ox, oy = int((W - card.shape[1]) / 2 + r2.uniform(-40, 40)), int((H - card.shape[0]) / 2 + r2.uniform(-80, 80))
    x0, y0, x1, y1 = max(ox, 0), max(oy, 0), min(ox + card.shape[1], W), min(oy + card.shape[0], H)
    frame[y0:y1, x0:x1] = card[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
    truth = truth * s + [ox, oy]
    fingers = 0
    if k % 2 == 1:
        frame, fingers = add_fingers(frame, truth.astype(np.float32), r2)
        while fingers == 0:
            frame, fingers = add_fingers(frame, truth.astype(np.float32), r2)
    return np.ascontiguousarray(np.dstack([frame, np.full(frame.shape[:2], 255, np.uint8)])), truth, NAMES[i], fingers


def work_sim(f):
    out = []
    for k in range(2):
        rgba, truth, right, fingers = sim_frame(f, k)
        row = {"fingers": fingers}
        for j, det in enumerate(DETS):
            q, vote = identify(det, rgba)
            row[j] = {"found": q is not None, "err": corner_err(q, truth) if q is not None else None, **(lead(rgba, q, right) if q is not None else {"lock": False, "top_right": False})}
        out.append(row)
    return out


def work_real(r):
    rgb = cv2.cvtColor(cv2.imread(f"{REAL}/{r['id']}.jpg"), cv2.COLOR_BGR2RGB)
    rgba = np.ascontiguousarray(np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)]))
    phone = np.float32(json.loads(r["quad"])) if isinstance(r["quad"], str) else np.float32(r["quad"])
    row = {"phone": lead(rgba, phone, r["label_name"])}
    for j, det in enumerate(DETS):
        q, vote = identify(det, rgba)
        row[j] = {"found": q is not None, "vs_phone": corner_err(q, phone) if q is not None else None, **(lead(rgba, q, r["label_name"]) if q is not None else {"lock": False, "top_right": False})}
    return row


def window_eval(dets):
    rows = [r for f in sorted(glob.glob(f"{DATA}/val/labels_*.json")) for r in json.load(open(f))]
    ss = [sess(d) for d in dets]
    res = {j: {"err": [], "err_f": [], "pres": 0} for j in range(len(dets))}
    for r in rows:
        win = cv2.cvtColor(cv2.imread(f"{DATA}/val/{r['file']}"), cv2.COLOR_BGR2RGB)
        rgba = np.ascontiguousarray(np.dstack([win, np.full(win.shape[:2], 255, np.uint8)]))
        for j, s in enumerate(ss):
            q, up, c, sh = s.run(None, {"window": rgba})
            p = float(np.hypot(*up)) / 4 >= 0.5
            res[j]["pres"] += p == r["present"]
            if r["present"]:
                (res[j]["err_f"] if r["fingers"] else res[j]["err"]).append(corner_err(q, np.float32(r["quad"])))
    print(f"\n== validation windows ({len(rows)}; held-out cards)")
    for j, d in enumerate(dets):
        e, ef = np.array(res[j]["err"]), np.array(res[j]["err_f"])
        print(f"  {d}: corner error / short side, no fingers: median {np.median(e):.2%} p90 {np.percentile(e, 90):.1%} (>25% {np.mean(e > 0.25):.1%}); "
              f"fingers: median {np.median(ef):.2%} p90 {np.percentile(ef, 90):.1%} (>25% {np.mean(ef > 0.25):.1%}); presence right {res[j]['pres'] / len(rows):.1%}")


def summarise(tag, rows, dets, key):
    if not rows:
        return
    print(f"\n== {tag} ({len(rows)})")
    for j, d in enumerate(dets):
        rs = [r[j] for r in rows]
        found = np.mean([x["found"] for x in rs]); lock = np.mean([x["lock"] and x["top_right"] for x in rs])
        wrong = sum(x["lock"] and not x["top_right"] for x in rs); top = np.mean([x["top_right"] for x in rs])
        errs = np.array([x[key] for x in rs if x[key] is not None])
        print(f"  {d}: found {found:.1%}, right card first {top:.1%}, lead-rule lock right {lock:.1%} wrong {wrong}; {key} median {np.median(errs):.2%} p90 {np.percentile(errs, 90):.1%}")


if __name__ == "__main__":
    dets = sys.argv[1:]
    if os.environ.get("WINDOWS", "1") == "1":
        window_eval(dets)
    from realeval import ROWS, COLS
    names = {r[COLS.index("name")].split(" // ")[0] for r in ROWS}
    manifest = [json.loads(l) for l in open(f"{REAL}/manifest.jsonl")]
    manifest = [r for r in manifest if r.get("label_name") and r["label_name"].split(" // ")[0] in names and os.path.exists(f"{REAL}/{r['id']}.jpg")]
    for r in manifest: r["label_name"] = r["label_name"].split(" // ")[0]
    files = [f for f in sorted(glob.glob("data/cards/*.jpg")) if int(hashlib.md5(os.path.basename(f)[:-4].encode()).hexdigest(), 16) % 25 == 0]
    files = files[: int(os.environ.get("SIMS", 400))]
    with Pool(int(os.environ.get("PROCS", 4)), initializer=init, initargs=(dets,)) as p:
        real = p.map(work_real, manifest, chunksize=4)
        sims = [x for c in p.imap(work_sim, files, chunksize=4) for x in c]
    ph = [r["phone"] for r in real]
    print(f"\n== real photos with the phone's own quad ({len(real)}): right card first {np.mean([x['top_right'] for x in ph]):.1%}, lead-rule lock right {np.mean([x['lock'] and x['top_right'] for x in ph]):.1%} wrong {sum(x['lock'] and not x['top_right'] for x in ph)}")
    summarise("real photos, each detector", real, dets, "vs_phone")
    summarise("simulated frames, no fingers", [s for s in sims if s["fingers"] == 0], dets, "err")
    summarise("simulated frames, fingers over corners or edges", [s for s in sims if s["fingers"] > 0], dets, "err")
    json.dump({"real": real, "sims": sims}, open("out/corners_eval.json", "w"))
