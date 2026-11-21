"""Frames for the speed bench (speed/drive.mjs): simulated captures (sim.py) of held-out cards (md5(id) % 25 == 0,
as train.py holds them out) placed in a portrait 640 x 1138 frame, a 2160 x 3840 phone frame at the recognizer's
640 px short side, four frames per card with a little movement, so the recognizer's tracking runs as it does live.
python <lab>/speed_frames.py [CARDS]   (from the work directory; writes speed/frames/NNN.png and index.json)"""
import glob, hashlib, json, os, sys
import numpy as np, cv2
import sim

W, H, PER = 640, 1138, 4


def main(n):
    held = [c for c in sorted(glob.glob("data/cards/*.jpg")) if int(hashlib.md5(os.path.basename(c)[:-4].encode()).hexdigest(), 16) % 25 == 0]
    if not held:
        raise SystemExit("No held-out cards in data/cards/ (README.md, \"Making the model again\").")
    rng = np.random.default_rng(20261120)
    os.makedirs("speed/frames", exist_ok=True)
    index, k = [], 0
    for ci in rng.choice(len(held), min(n, len(held)), replace=False):
        rgb = cv2.cvtColor(cv2.imread(held[ci]), cv2.COLOR_BGR2RGB)
        scene, quad, meta = sim.render(rgb, rng, level=float(rng.uniform(0.3, 1.5)))
        sh, sw = scene.shape[:2]
        s = rng.uniform(0.55, 0.8) * W / sw  # the card's scene fills 55 to 80% of the width
        card = cv2.resize(scene, (int(sw * s), int(sh * s)), interpolation=cv2.INTER_AREA)
        ground = cv2.resize(cv2.GaussianBlur(scene, (0, 0), 25), (W, H), interpolation=cv2.INTER_LINEAR)
        for f in range(PER):
            frame = ground.copy()
            ox = int((W - card.shape[1]) / 2 + rng.uniform(-12, 12)); oy = int((H - card.shape[0]) / 2 + rng.uniform(-20, 20))
            x0, y0, x1, y1 = max(ox, 0), max(oy, 0), min(ox + card.shape[1], W), min(oy + card.shape[0], H)
            frame[y0:y1, x0:x1] = card[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
            name = f"{k:03d}.png"
            cv2.imwrite(f"speed/frames/{name}", cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
            index.append({"file": name, "card": os.path.basename(held[ci])[:-4], "frame": f, "quad": (quad * s + np.array([ox, oy], np.float32)).tolist(), **meta})
            k += 1
    json.dump(index, open("speed/frames/index.json", "w"))
    print(k, "frames in speed/frames/")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 40)
