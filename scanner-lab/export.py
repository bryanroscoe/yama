"""Export a fine-tuned embedder as a full embed.onnx: the bundle's front graph (warp and cuts) feeding
our embedder, with the same inputs (scene, quad) and output (embeddings) as the bundle's graph.
python <lab>/export.py runs/<run>/epN.pt models/<name>.onnx"""
import os, sys
import numpy as np, onnx, torch, onnxruntime as ort, json, cv2
from onnx import compose
from model import load_bundle_embedder
from paths import REAL
ckpt, out = sys.argv[1], sys.argv[2]
m = load_bundle_embedder(); m.load_state_dict(torch.load(ckpt, map_location="cpu")); m.eval()
torch.onnx.export(m, torch.zeros(17, 3, 128, 128), "models/_back_new.onnx", input_names=["crops"], output_names=["embeddings"],
                  dynamic_axes={"crops": {0: "n"}, "embeddings": {0: "n"}}, opset_version=17, dynamo=False)
front = onnx.load("models/front.onnx"); back = onnx.load("models/_back_new.onnx")
back = compose.add_prefix(back, "q_")
merged = compose.merge_models(front, back, io_map=[("/Div_5_output_0", "q_crops")])
merged.graph.output[0].name  # q_embeddings
# Rename the output to `embeddings`, as the scanner expects.
for n in merged.graph.node:
    for i, o in enumerate(n.output):
        if o == "q_embeddings": n.output[i] = "embeddings"
merged.graph.output[0].name = "embeddings"
onnx.checker.check_model(merged)
onnx.save(merged, out)
# Check: the merged graph against torch on a real photo, or a made-up scene without the photo set.
if os.path.exists(f"{REAL}/manifest.jsonl"):
    r = json.loads(open(f"{REAL}/manifest.jsonl").readline())
    rgb = cv2.cvtColor(cv2.imread(f"{REAL}/{r['id']}.jpg"), cv2.COLOR_BGR2RGB); q = np.asarray(json.loads(r["quad"]), np.float32)
else:
    rgb = np.random.default_rng(0).integers(0, 256, (640, 480, 3), dtype=np.uint8); q = np.float32([[60, 40], [420, 50], [430, 600], [50, 590]])
rgba = np.ascontiguousarray(np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)]))
s = ort.InferenceSession(out); e = s.run(None, {"scene": rgba, "quad": q})[0]
crops = ort.InferenceSession("models/front.onnx").run(None, {"scene": rgba, "quad": q})[0]
with torch.no_grad(): t = m(torch.from_numpy(crops)).numpy()
print("inputs", [i.name for i in s.get_inputs()], "outputs", [o.name for o in s.get_outputs()], "max diff vs torch", float(np.abs(e - t).max()), "bytes", len(open(out, 'rb').read()))
