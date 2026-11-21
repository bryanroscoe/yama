"""Training windows for a corner detector: the detector's 256 px window as the recognizer cuts it (a coarse
window with the card anywhere at 28-98% of the side, or a fine one with the card's long side near 60%), any
rotation, sleeves and glare from sim.py, fingers or a thumb over corners and edges, other cards half in view,
and windows with no card. Labels: the card's four corners as printed (TL, TR, BR, BL) in window pixels, even
where covered or outside the window, and whether a card is there.
python <lab>/corners_gen.py OUT_DIR START COUNT SEED   (cards: data/cards/*.jpg; held-out ones are md5 % 25 == 0)
Env: SPLIT=val for the held-out cards, MODE=photo for tight photos of the card windowed as the scanner does,
CHUNK (250) renders per labels file."""
import sys, os, glob, hashlib, json
import numpy as np, cv2
import sim

S = 256
SKIN = [(0.98, 0.80, 0.70), (0.93, 0.72, 0.60), (0.80, 0.58, 0.45), (0.62, 0.42, 0.30), (0.42, 0.28, 0.20), (0.30, 0.20, 0.15)]


def held(path):
    return int(hashlib.md5(os.path.basename(path)[:-4].encode()).hexdigest(), 16) % 25 == 0


def warp_window(img, quad, rng, kind):
    """Cut a window as the recognizer would around the card, rotated; returns window, quad in window px."""
    c = quad.mean(0)
    long = max(np.linalg.norm(quad[0] - quad[3]), np.linalg.norm(quad[1] - quad[2]))
    if kind == "fine":
        side = long / rng.uniform(0.45, 0.78)
        centre = c + rng.normal(0, 0.06 * long, 2)
    else:
        side = long / rng.uniform(0.28, 0.98)
        centre = c + rng.uniform(-0.35, 0.35, 2) * side * (1 - long / side * 0.7)
    theta = rng.uniform(0, 360) if rng.random() < 0.5 else rng.integers(4) * 90 + rng.normal(0, 8)
    k = S / side
    M = cv2.getRotationMatrix2D((float(centre[0]), float(centre[1])), float(theta), k)
    M[:, 2] += np.array([S / 2, S / 2]) - centre
    flags = cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR
    win = cv2.warpAffine(img, M, (S, S), flags=flags, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
    # Past the scene's edge: its edge smeared out and out of focus, with sensor noise (not a mirror image,
    # which would repeat the card).
    valid = cv2.warpAffine(np.ones(img.shape[:2], np.float32), M, (S, S), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    if valid.min() < 0.99:
        fill = cv2.GaussianBlur(win, (0, 0), rng.uniform(6, 14)) * rng.uniform(0.85, 1.05)
        fill = fill + rng.standard_normal(fill.shape).astype(np.float32) * rng.uniform(1, 6)
        m = cv2.GaussianBlur(valid, (0, 0), 1.5)[..., None]
        win = win * m + fill * (1 - m)
    win = np.clip(win, 0, 255).astype(np.uint8)
    q = cv2.transform(quad[None].astype(np.float32), M)[0]
    return win, q


def photo_windows(img, quad, rng):
    """The scanner's own windows on a tight photo of the card: the coarse pass on the 640 px square at the
    middle (the photo's edge clamped beyond, as sampleWindow does), then the fine pass around the card
    with its long side near 60% of the window."""
    h, w = img.shape[:2]
    out = []
    long = max(np.linalg.norm(quad[0] - quad[3]), np.linalg.norm(quad[1] - quad[2]))
    c = quad.mean(0)
    for kind in ("coarse", "fine"):
        if kind == "coarse":
            side = rng.uniform(0.9, 1.1) * max(640.0 * h / 640.0, long * 1.02); centre = np.array([w / 2, h / 2])
        else:
            side = long / rng.uniform(0.5, 0.7); centre = c + rng.normal(0, 0.03 * long, 2)
        theta = 0.0 if rng.random() < 0.6 else rng.choice([90.0, 180.0, 270.0]) + rng.normal(0, 3)
        k = S / side
        M = cv2.getRotationMatrix2D((float(centre[0]), float(centre[1])), float(theta), k)
        M[:, 2] += np.array([S / 2, S / 2]) - centre
        win = cv2.warpAffine(img, M, (S, S), flags=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        out.append((win, cv2.transform(quad[None].astype(np.float32), M)[0], kind))
    return out


def finger(win, rng, tip, direction, width, length):
    """A finger as a shaded capsule from `tip` back along -direction."""
    h, w = win.shape[:2]
    up = 3
    big = np.zeros((h * up, w * up), np.float32)
    d = direction / (np.linalg.norm(direction) + 1e-6)
    n = np.array([-d[1], d[0]])
    a, b = tip * up, (tip - d * length) * up
    r = width * up / 2
    poly = np.array([a + n * r, a - n * r, b - n * r, b + n * r], np.int32)
    cv2.fillConvexPoly(big, poly, 1.0, lineType=cv2.LINE_AA)
    cv2.circle(big, tuple(int(v) for v in a), int(r), 1.0, -1, lineType=cv2.LINE_AA)
    mask = cv2.resize(big, (w, h), interpolation=cv2.INTER_AREA)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    across = ((xx - tip[0]) * n[0] + (yy - tip[1]) * n[1]) / (width / 2 + 1e-6)
    shade = np.clip(np.cos(np.clip(across, -1, 1) * 1.25), 0.15, 1.0)
    base = np.array(SKIN[rng.integers(len(SKIN))]) * rng.uniform(0.75, 1.15)
    colour = base[None, None, :] * (0.55 + 0.45 * shade[..., None])
    spec = np.exp(-((across - rng.uniform(-0.5, 0.2)) ** 2) / 0.02) * rng.uniform(0.0, 0.25)
    colour = colour + spec[..., None]
    if rng.random() < 0.5:  # a nail near the tip
        along = (xx - tip[0]) * -d[0] + (yy - tip[1]) * -d[1]
        nail = np.exp(-((along - width * 0.45) ** 2 / (width * 0.3) ** 2 + across ** 2 / 0.35)) > 0.5
        colour[nail] = colour[nail] * 0.7 + 0.3 * np.array([0.95, 0.85, 0.85])
    blur = rng.uniform(0.5, 2.5)
    mask = cv2.GaussianBlur(mask, (0, 0), blur)[..., None]
    colour = cv2.GaussianBlur(colour.astype(np.float32), (0, 0), blur)
    out = win.astype(np.float32) / 255 * (1 - mask) + np.clip(colour, 0, 1) * mask
    return (out * 255).astype(np.uint8)


def add_fingers(win, q, rng):
    short = min(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[1]))
    centre = q.mean(0)
    r = rng.random()
    count = 0 if r < 0.45 else 1 if r < 0.8 else 2
    for _ in range(count):
        if rng.random() < 0.75:  # over a corner
            p = q[rng.integers(4)]
            depth = rng.uniform(-0.05, 0.3) * short
        else:  # a thumb on an edge
            i = rng.integers(4); t = rng.uniform(0.2, 0.8)
            p = q[i] * (1 - t) + q[(i + 1) % 4] * t
            depth = rng.uniform(0.0, 0.25) * short
        inward = centre - p
        inward = inward / (np.linalg.norm(inward) + 1e-6)
        ang = np.deg2rad(rng.normal(0, 30))
        R = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
        d = R @ inward
        tip = p + d * depth
        win = finger(win, rng, tip, d, rng.uniform(0.2, 0.34) * short, rng.uniform(2.5, 5) * short)
    return win, count


def other_card(win, rng, cards):
    """Part of another card at the window's edge, under 40% in view."""
    img = cv2.cvtColor(cv2.imread(cards[rng.integers(len(cards))]), cv2.COLOR_BGR2RGB)
    h = rng.uniform(0.5, 1.0) * S; w = h * 63 / 88
    ang = rng.uniform(0, 360)
    edge = rng.integers(4)
    pos = {0: (rng.uniform(0, S), -h * rng.uniform(0.15, 0.35)), 1: (S + h * rng.uniform(0.15, 0.35), rng.uniform(0, S)),
           2: (rng.uniform(0, S), S + h * rng.uniform(0.15, 0.35)), 3: (-h * rng.uniform(0.15, 0.35), rng.uniform(0, S))}[edge]
    pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
    R = np.array([[np.cos(np.deg2rad(ang)), -np.sin(np.deg2rad(ang))], [np.sin(np.deg2rad(ang)), np.cos(np.deg2rad(ang))]])
    dst = (pts @ R.T + pos).astype(np.float32)
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [img.shape[1], 0], [img.shape[1], img.shape[0]], [0, img.shape[0]]]), dst)
    warped = cv2.warpPerspective(img, M, (S, S))
    m = cv2.warpPerspective(np.ones(img.shape[:2], np.float32), M, (S, S))[..., None]
    shade = rng.uniform(0.5, 1.0)
    return (win * (1 - m) + warped * m * shade).astype(np.uint8)


def sample(card_path, rng, cards):
    card = cv2.cvtColor(cv2.imread(card_path), cv2.COLOR_BGR2RGB)
    level = rng.uniform(0.2, 2.0)
    photo = os.environ.get("MODE") == "photo"
    img, _, meta = sim.render(card, rng, level, 0.75, room=(1.03, 1.15) if photo else (1.2, 1.9) if rng.random() < 0.5 else (1.15, 1.4))
    quad = np.float32(meta["card_quad"])
    out = []
    views = photo_windows(img, quad, rng) if photo else [(*warp_window(img, quad, rng, kind), kind) for kind in ("coarse", "fine")]
    for win, q, kind in views:
        n = 0
        win, n = add_fingers(win, q, rng)
        if rng.random() < 0.1:
            win = other_card(win, rng, cards)
        inside = np.clip(q, 0, S)
        area_in = cv2.contourArea(inside.astype(np.float32))
        area = cv2.contourArea(q.astype(np.float32))
        present = area > 0 and area_in / area > 0.5 and min(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[1])) >= 20
        out.append((win, q, present, n, kind))
    return out, meta


def negative(rng, cards):
    """A window with no card in it: a background, light and noise, sometimes a card's edge."""
    bg, _ = sim.background(rng, S, S)
    illum = 0.55 + 0.6 * sim.smooth_field(rng, S, S, rng.uniform(1.2, 3))
    img = np.clip(bg * illum[..., None] * rng.uniform(0.6, 1.2), 0, 1)
    img = (img * 255 + rng.standard_normal(img.shape) * rng.uniform(1, 8)).clip(0, 255).astype(np.uint8)
    if rng.random() < 0.5:
        img = other_card(img, rng, cards)
    if rng.random() < 0.3:
        img, _ = add_fingers(img, np.float32([[60, 60], [190, 60], [190, 240], [60, 240]]) + rng.uniform(-50, 50, 2).astype(np.float32), rng)
    return img


if __name__ == "__main__":
    out_dir, start, count, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    split = os.environ.get("SPLIT", "train")
    chunk = int(os.environ.get("CHUNK", 250))
    cards = sorted(glob.glob("data/cards/*.jpg"))
    pool = [c for c in cards if held(c) == (split == "val")]
    os.makedirs(out_dir, exist_ok=True)
    rng = np.random.default_rng(seed)
    for c0 in range(start, start + count, chunk):
        labels = []
        for i in range(c0, min(c0 + chunk, start + count)):
            if rng.random() < 0.08:
                win = negative(rng, cards)
                name = f"{i:06d}n.jpg"
                cv2.imwrite(os.path.join(out_dir, name), cv2.cvtColor(win, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
                labels.append({"file": name, "present": False, "quad": None, "fingers": 0, "kind": "none"})
                continue
            path = pool[rng.integers(len(pool))]
            windows, meta = sample(path, rng, cards)
            for j, (win, q, present, n, kind) in enumerate(windows):
                name = f"{i:06d}{'cf'[j]}.jpg"
                cv2.imwrite(os.path.join(out_dir, name), cv2.cvtColor(win, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
                labels.append({"file": name, "present": bool(present), "quad": q.tolist(), "fingers": n, "kind": kind, "card": os.path.basename(path)[:-4], "sleeved": meta["sleeved"]})
        # Labels per chunk, written last, so a stopped run leaves only whole chunks labelled.
        json.dump(labels, open(os.path.join(out_dir, f"labels_{c0:06d}.json"), "w"))
        print("chunk", c0, len(labels), flush=True)
