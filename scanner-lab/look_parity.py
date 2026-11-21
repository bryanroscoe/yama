"""Expected outputs of a printing look model (yama-look-v0.onnx, -v1) on synthetic scenes (no card
images), for the repository's parity test (web/src/scanner/eval/look.test.ts, one file per model:
look-parity-v0.json, -v1.json). python look_parity.py MODEL OUT.json"""
import sys, json, hashlib
import numpy as np, onnxruntime as ort

model, out = sys.argv[1], sys.argv[2]
s = ort.InferenceSession(model, providers=["CPUExecutionProvider"])


def scene(w, h):
    y, x = np.mgrid[0:h, 0:w].astype(np.int64)
    r = (x * 7 + y * 3) & 255
    g = (((x * x) >> 3) + y * 5) & 255
    b = ((x ^ y) * 3) & 255
    return np.ascontiguousarray(np.dstack([r, g, b, np.full_like(r, 255)]).astype(np.uint8))


cases = [
    # A camera-like frame with the card tilted inside it.
    {"name": "frame", "width": 360, "height": 640, "quad": [[52.5, 101.0], [318.0, 88.25], [331.75, 470.5], [61.0, 486.0]]},
    # A candidate printing's own picture: the quad is its corners.
    {"name": "printing", "width": 488, "height": 680, "quad": [[0, 0], [488, 0], [488, 680], [0, 680]]},
]
for c in cases:
    sym, card = s.run(None, {"scene": scene(c["width"], c["height"]), "quad": np.asarray(c["quad"], np.float32)})
    c["symbol"] = [round(float(v), 6) for v in sym[0]]
    c["card"] = [round(float(v), 6) for v in card[0]]
sha = hashlib.sha256(open(model, "rb").read()).hexdigest()
json.dump({"model": sha, "onnxruntime": ort.__version__, "cases": cases}, open(out, "w"), indent=None, separators=(",", ":"))
print("wrote", out, "for", sha[:12])
