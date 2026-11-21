"""An exported printing look model (ONNX, run as the phone runs it) on the labelled real photos whose
artwork several printings share (LOOK.md). Query: the photo with the phone's quad; candidates: each
printing's Scryfall `normal` image with its corners. Prints the exact printing rate, the rate counting
strict visual twins (look_crops.strict_twin) as right, and how many photos a lead rule would settle: on
the raw lead over the next printing (what an app can run), and, for analysis, over the best non-twin.
python <lab>/look_eval.py models/<look>.onnx [symbol weight, 0.8]"""
import json, sys, time
import numpy as np, cv2, onnxruntime as ort
from look_crops import cases, strict_twin
from paths import REAL


def main():
    path = sys.argv[1]; w = float(sys.argv[2]) if len(sys.argv) > 2 else 0.8
    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    def run(rgb, quad):
        rgba = np.ascontiguousarray(np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)]))
        a, b = session.run(None, {"scene": rgba, "quad": np.asarray(quad, np.float32)})
        return a[0], b[0]

    keys = {}

    def key(pid):
        if pid not in keys:
            rgb = cv2.cvtColor(cv2.imread(f"data/printings/{pid}.jpg"), cv2.COLOR_BGR2RGB); h, w_ = rgb.shape[:2]
            keys[pid] = run(rgb, [[0, 0], [w_, 0], [w_, h], [0, h]])
        return keys[pid]

    cs = cases(); rows = []; ms_taken = []
    for r, pid, ms in cs:
        rgb = cv2.cvtColor(cv2.imread(f"{REAL}/{r['id']}.jpg"), cv2.COLOR_BGR2RGB)
        t0 = time.time(); qs, qc = run(rgb, json.loads(r["quad"])); ms_taken.append(time.time() - t0)
        s = np.array([w * float(key(m)[0] @ qs) + (1 - w) * float(key(m)[1] @ qc) for m in ms])
        order = np.argsort(-s); pick = ms[order[0]]
        twins = [m for m in ms if m != pick and strict_twin(pick, m)]
        rivals = [s[i] for i in order[1:] if ms[i] not in twins]
        rows.append((s[order[0]] - (max(rivals) if rivals else -1), pick == pid, bool(twins), pick == pid or pid in twins,
                     s[order[0]] - s[order[1]]))
    n = len(rows)
    print(f"{path}: {n} photos, {np.median(ms_taken) * 1000:.0f} ms per image (onnxruntime CPU), symbol weight {w}")
    print(f"  exact printing {sum(x[1] for x in rows)}/{n} = {sum(x[1] for x in rows) / n:.1%}; "
          f"right or a strict visual twin {sum(x[3] for x in rows) / n:.1%}")
    print("  The rule an app can run, on the raw lead of the top printing over the next (twins included):")
    for t in (0.04, 0.06, 0.08, 0.10, 0.15):
        alone = [x for x in rows if x[4] >= t]
        print(f"    lead >= {t:.2f}: picked alone {len(alone)} ({sum(not x[1] for x in alone)} wrong); to the collector line {n - len(alone)}")
    print("  For analysis (uses the strict-twin labels, which an app doesn't have): lead over the best non-twin")
    for t in (0.0, 0.04, 0.06, 0.08, 0.10, 0.15):
        alone = [x for x in rows if x[0] >= t and not x[2]]; twin = [x for x in rows if x[0] >= t and x[2]]
        print(f"    lead >= {t:.2f}: picked alone {len(alone)} ({sum(not x[1] for x in alone)} wrong); "
              f"narrowed to strict twins {len(twin)} ({sum(x[3] for x in twin)} the right twins); to the collector line {n - len(alone) - len(twin)}")


if __name__ == "__main__":
    main()
