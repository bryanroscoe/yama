"""Pre-generate training crops: for each downloaded card, K simulated captures, warped and cut by the
bundle's own front graph (scene, quad -> the 17 frame crops), keeping the crop for the card's frame.
Saved as data/crops/<row>_<k>.jpg (the 128x128 crop before ImageNet normalisation)."""
import sys, glob, os
import numpy as np, cv2
from multiprocessing import Pool
K = int(os.environ.get("K", 4))
MEAN = np.array([0.485, 0.456, 0.406], np.float32)[:, None, None]; STD = np.array([0.229, 0.224, 0.225], np.float32)[:, None, None]

def work(f):
    import onnxruntime as ort
    from sim import render
    from realeval import ROWS, COLS, FRAMES
    global _front, _row_of
    if "_front" not in globals():
        o = ort.SessionOptions(); o.intra_op_num_threads = 1
        _front = ort.InferenceSession("models/front.onnx", o, providers=["CPUExecutionProvider"])
        _row_of = {r[COLS.index("id")]: i for i, r in enumerate(ROWS)}
    i = _row_of[os.path.basename(f)[:-4]]
    card = None
    for k in range(K):
        out = f"data/crops/{i}_{k}.jpg"
        if os.path.exists(out): continue
        if card is None: card = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
        rng = np.random.default_rng(i * 100 + k)
        level = rng.uniform(0.2, 2.0)
        img, q, meta = render(card, rng, level, 0.75)
        rgba = np.ascontiguousarray(np.dstack([img, np.full(img.shape[:2], 255, np.uint8)]))
        crops = _front.run(None, {"scene": rgba, "quad": q})[0]
        c = crops[FRAMES[i]] * STD + MEAN
        c = np.clip(np.rint(c.transpose(1, 2, 0) * 255), 0, 255).astype(np.uint8)
        cv2.imwrite(out + ".part.jpg", cv2.cvtColor(c, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
        os.replace(out + ".part.jpg", out)
    return 1

if __name__ == "__main__":
    os.makedirs("data/crops", exist_ok=True)
    files = sorted(glob.glob("data/cards/*.jpg"))
    with Pool(6) as p:
        for n, _ in enumerate(p.imap_unordered(work, files, chunksize=8)):
            if n % 2000 == 0: print(n, "cards", flush=True)
    print("done", len(files), "cards", flush=True)
