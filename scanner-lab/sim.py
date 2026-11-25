"""Synthetic phone captures of a card, with what Bryan's real scans show: textured matte sleeves
(a fine mesh, sparkle on every bump, a white haze), glossy sleeve glare, the sleeve's coloured
edge, foil sheen, a blue deck box with cards behind, colour casts, and phone optics (defocus,
motion, noise, sharpening, JPEG, the browser's downscale to a 640 px short side).

render(card_rgb, rng, level) -> (scene uint8 HxWx3 at the recognizer's scale, quad 4x2 TL,TR,BR,BL)
`level` 0..1 scales how rough the capture is; per-effect probabilities stay the same.
"""
import cv2
import numpy as np

CARD_W, CARD_H = 63.0, 88.0


def smooth_field(rng, h, w, scale):
    """Low-frequency random field in [0, 1]."""
    sh, sw = max(2, int(round(scale * h / max(h, w)))), max(2, int(round(scale * w / max(h, w))))
    f = rng.random((sh + 2, sw + 2)).astype(np.float32)
    f = cv2.resize(f, (64, 64), interpolation=cv2.INTER_CUBIC)
    f = cv2.GaussianBlur(f, (0, 0), 64 / max(sh, sw) / 2)
    f = cv2.resize(f[4:-4, 4:-4], (w, h), interpolation=cv2.INTER_LINEAR)
    f -= f.min(); f /= max(f.max(), 1e-6)
    return f


def soft_blobs(rng, h, w, n, size):
    """Elongated soft highlight blobs, peak 1."""
    H0, W0 = h, w
    k = 8; h, w, size = max(h // k, 4), max(w // k, 4), size / k
    m = np.zeros((h, w), np.float32)
    for _ in range(n):
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        ax = rng.uniform(0.15, 0.6) * size; ay = ax * rng.uniform(0.15, 0.6)
        ang = rng.uniform(0, 180)
        blob = np.zeros_like(m)
        cv2.ellipse(blob, (int(cx), int(cy)), (int(ax), int(max(ay, 2))), ang, 0, 360, 1.0, -1)
        blob = cv2.GaussianBlur(blob, (0, 0), max(ay, 2) * rng.uniform(0.4, 1.0))
        m = np.maximum(m, blob / max(blob.max(), 1e-6))
    return cv2.resize(m, (W0, H0), interpolation=cv2.INTER_LINEAR)


def mesh_texture(rng, h, w, period):
    """A sleeve's embossed texture: a rotated diamond mesh, a random stipple, or both, in [0, 1]."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = np.deg2rad(rng.uniform(0, 90))
    u = xx * np.cos(a) + yy * np.sin(a); v = -xx * np.sin(a) + yy * np.cos(a)
    grid = (0.5 + 0.5 * np.sin(2 * np.pi * u / period) * np.sin(2 * np.pi * v / period)) ** rng.uniform(1.5, 4)
    stipple = rng.random((h, w)).astype(np.float32)
    stipple = cv2.GaussianBlur(stipple, (0, 0), period / 4)
    stipple = np.clip((stipple - np.percentile(stipple, rng.uniform(70, 92))) * 8, 0, 1)
    mix = rng.uniform(0, 1)
    return (mix * grid + (1 - mix) * stipple).astype(np.float32)


def foil(rng, img):
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = rng.uniform(0, np.pi)
    t = (xx * np.cos(a) + yy * np.sin(a)) / max(h, w) * rng.uniform(1.5, 4) + rng.uniform(0, 1)
    hue = ((t % 1.0) * 180).astype(np.uint8)
    hsv = np.dstack([hue, np.full_like(hue, 200), np.full_like(hue, 255)])
    rainbow = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB).astype(np.float32) / 255
    k = rng.uniform(0.08, 0.35) * smooth_field(rng, h, w, rng.uniform(2, 5))[..., None]
    out = 1 - (1 - img) * (1 - rainbow * k)  # screen blend
    return out


def background(rng, h, w):
    kind = rng.choice(["box", "table", "mat", "paper", "hand"], p=[0.4, 0.2, 0.15, 0.1, 0.15])
    if kind == "box":
        base = np.array([rng.uniform(0.05, 0.25), rng.uniform(0.15, 0.4), rng.uniform(0.5, 0.95)])
    elif kind == "table":
        base = np.array([rng.uniform(0.35, 0.6), rng.uniform(0.22, 0.4), rng.uniform(0.1, 0.25)])
    elif kind == "mat":
        base = np.full(3, rng.uniform(0.02, 0.12))
    elif kind == "paper":
        base = np.full(3, rng.uniform(0.75, 0.95))
    else:
        base = np.array([rng.uniform(0.7, 0.9), rng.uniform(0.5, 0.65), rng.uniform(0.4, 0.55)])
    bg = np.ones((h, w, 3), np.float32) * base.astype(np.float32)
    bg *= (0.6 + 0.6 * smooth_field(rng, h, w, 3))[..., None]
    bg += rng.standard_normal((h, w, 3), dtype=np.float32) * np.float32(0.02)
    return np.clip(bg, 0, 1), kind


def place(rng, dst, src, quad_dst, alpha=None):
    h, w = src.shape[:2]
    srcq = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(srcq, np.float32(quad_dst))
    warped = cv2.warpPerspective(src, M, (dst.shape[1], dst.shape[0]), flags=cv2.INTER_LINEAR)
    a = np.ones((h, w), np.float32) if alpha is None else alpha
    wa = cv2.warpPerspective(a, M, (dst.shape[1], dst.shape[0]), flags=cv2.INTER_LINEAR)[..., None]
    return dst * (1 - wa) + warped * wa, M


def card_unit(card_rgb, rng, L, work_h, sleeve_p, colour="draw"):
    """The card as the camera sees it, flat: foil sheen, a sleeve (its coloured edge, texture, haze and
    glare) or a bare card's reflection. Returns the unit (float RGB), its alpha, the sleeve's pad and the
    card's size inside it. `colour` fixes the sleeve's colour (a deck sleeved alike) instead of drawing it."""
    work_w = int(work_h * CARD_W / CARD_H)
    card = cv2.resize(card_rgb, (work_w, work_h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255

    if rng.random() < 0.25:
        card = foil(rng, card)

    sleeved = rng.random() < sleeve_p
    pad = int(work_w * rng.uniform(0.02, 0.05)) if sleeved else 0
    sw, sh = work_w + 2 * pad, work_h + 2 * pad
    unit = np.zeros((sh, sw, 3), np.float32)
    if sleeved:
        colours = [(0.02, 0.02, 0.02), (0.05, 0.1, 0.45), (0.5, 0.05, 0.05), (0.05, 0.35, 0.1), (0.3, 0.05, 0.4), (0.9, 0.9, 0.9), None]
        c = colours[rng.integers(len(colours))] if isinstance(colour, str) else colour
        edge = np.ones((sh, sw, 3), np.float32) * np.float32(np.array(c) if c is not None else rng.uniform(0.2, 0.6))
        unit[:] = edge
    unit[pad:pad + work_h, pad:pad + work_w] = card
    # Rounded corners of the card itself show the sleeve (or background) behind.
    alpha = np.ones((sh, sw), np.float32)

    if sleeved:
        glare = smooth_field(rng, sh, sw, rng.uniform(1.5, 4))
        glare = np.clip(glare * rng.uniform(0.6, 1.4) - rng.uniform(0, 0.4), 0, 1)
        if rng.random() < 0.65:  # matte, textured
            period = rng.uniform(2.5, 8.0)
            tex = mesh_texture(rng, sh, sw, period)
            haze = (rng.uniform(0.03, 0.18) + rng.uniform(0.05, 0.45) * glare) * L
            white = np.float32(rng.uniform(0.85, 1.0))
            haze = haze.astype(np.float32)
            unit = unit * (1 - haze[..., None]) + white * haze[..., None]
            sparkle = (rng.uniform(0.1, 0.6) * L) * (0.3 + glare) * tex
            unit = unit + sparkle[..., None]
            unit = unit * (1 - 0.15 * L * (tex[..., None] - 0.5))
        else:  # glossy
            blobs = soft_blobs(rng, sh, sw, rng.integers(1, 4), max(sh, sw))
            unit = unit + (rng.uniform(0.3, 1.3) * L) * blobs[..., None]
            haze = rng.uniform(0.0, 0.15) * L * glare
            unit = unit * (1 - haze[..., None]) + haze[..., None]
    elif rng.random() < 0.3:  # bare card, a lamp's reflection
        blobs = soft_blobs(rng, sh, sw, 1, max(sh, sw))
        unit = unit + rng.uniform(0.2, 0.8) * L * blobs[..., None]
    return unit, alpha, {"pad": pad, "work_w": work_w, "work_h": work_h, "sleeved": sleeved, "colour": c if sleeved else None}


def capture(scene, rng, L):
    """The room's light and the phone's optics on a scene (float RGB, 0 to 1) at the working scale:
    an illumination field, a colour cast, exposure and gamma, defocus, motion, noise, sharpening and
    JPEG. Returns uint8 RGB at the same scale, and the cast."""
    H, W = scene.shape[:2]
    # Light: an illumination field, a colour cast, exposure and gamma.
    illum = np.float32(0.55) + np.float32(0.6) * smooth_field(rng, H, W, rng.uniform(1.2, 3))
    scene = scene * (1 - L * 0.5 + L * 0.5 * illum).astype(np.float32)[..., None]
    cast = rng.choice(["blue", "warm", "none"], p=[0.45, 0.25, 0.3])
    if cast == "blue":
        gains = np.array([rng.uniform(0.7, 0.95), rng.uniform(0.88, 1.0), rng.uniform(1.0, 1.25)])
    elif cast == "warm":
        gains = np.array([rng.uniform(1.0, 1.2), rng.uniform(0.95, 1.05), rng.uniform(0.75, 0.95)])
    else:
        gains = rng.uniform(0.95, 1.05, 3)
    scene = scene * (1 + L * (gains - 1)).astype(np.float32)
    scene = np.clip(scene * np.float32(rng.uniform(1 - 0.35 * L, 1 + 0.2 * L)), 0, 1) ** np.float32(rng.uniform(1 - 0.2 * L, 1 + 0.25 * L))

    # Optics and sensor at the working scale.
    img = (np.clip(scene, 0, 1) * 255).astype(np.float32)
    s = rng.uniform(0, 2.2) * L
    if s > 0.3:
        img = cv2.GaussianBlur(img, (0, 0), s)
    if rng.random() < 0.25 * L:
        n = int(rng.integers(3, 11)); k = np.zeros((n, n), np.float32); k[n // 2] = 1
        k = cv2.warpAffine(k, cv2.getRotationMatrix2D((n / 2 - 0.5, n / 2 - 0.5), rng.uniform(0, 180), 1), (n, n)); k /= max(k.sum(), 1e-6)
        img = cv2.filter2D(img, -1, k)
    img = img + rng.standard_normal(img.shape, dtype=np.float32) * np.float32(rng.uniform(1, 9) * L)
    if rng.random() < 0.7:  # phone sharpening
        blur = cv2.GaussianBlur(img, (0, 0), rng.uniform(1, 2.5))
        img = img + rng.uniform(0.2, 1.2) * (img - blur)
    img = np.clip(img, 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, int(rng.uniform(55, 95))])
    return cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB), cast


def render(card_rgb: np.ndarray, rng: np.random.Generator, level: float = 1.0, sleeve_p: float = 0.75, room=(1.15, 1.4)):
    """`room`: how much bigger than the card the scene is (a range). The defaults draw exactly what the
    shipped models were trained on; meta["card_quad"] is the card's true corners, for training a detector."""
    L = level
    # Working scale: twice the recognizer's, so textures alias on the way down as a 4K frame does.
    final_h = rng.uniform(300, 640)
    work_h = int(final_h * 2)
    unit, alpha, u = card_unit(card_rgb, rng, L, work_h, sleeve_p)
    pad, work_w, sleeved = u["pad"], u["work_w"], u["sleeved"]
    sh, sw = unit.shape[:2]

    # The scene: the card unit on a background, a bit of room around it.
    room = rng.uniform(*room)
    H, W = int(sh * room), int(sw * room * rng.uniform(0.9, 1.3))
    scene, kind = background(rng, H, W)
    cx, cy = W / 2 + rng.uniform(-0.08, 0.08) * W, H / 2 + rng.uniform(-0.08, 0.08) * H
    ang = np.deg2rad(rng.normal(0, 6) if rng.random() < 0.8 else rng.uniform(-20, 20))
    def corners(w, h, jitter):
        pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], np.float32)
        R = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]], np.float32)
        pts = pts @ R.T + [cx, cy]
        return pts + rng.normal(0, jitter, (4, 2)).astype(np.float32)
    persp = w_j = 0.035 * sw * L
    unit_q = corners(sw, sh, persp)
    if kind == "box" and rng.random() < 0.7:  # cards behind in the box, peeking out above
        for k in range(rng.integers(1, 4)):
            off = np.array([rng.normal(0, 0.01 * sw), -rng.uniform(0.01, 0.06) * sh], np.float32)
            behind = np.ones((sh, sw, 3), np.float32) * rng.uniform(0.02, 0.3)
            scene, _ = place(rng, scene, behind, unit_q + off)
    scene, M = place(rng, scene, unit, unit_q, alpha)
    card_corners = np.float32([[pad, pad], [pad + work_w, pad], [pad + work_w, pad + work_h], [pad, pad + work_h]])
    card_q = cv2.perspectiveTransform(card_corners[None], M)[0]

    img, cast = capture(scene, rng, L)

    # The browser's downscale to the recognizer's scale.
    f = 0.5
    interp = cv2.INTER_AREA if rng.random() < 0.5 else cv2.INTER_LINEAR
    img = cv2.resize(img, (int(img.shape[1] * f), int(img.shape[0] * f)), interpolation=interp)
    card_q = card_q * f

    # The detector's quad: the card's corners with error, or the sleeve's edge.
    width = np.linalg.norm(card_q[1] - card_q[0])
    q = card_q.copy()
    if sleeved and rng.random() < 0.3:
        q = cv2.perspectiveTransform(np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]])[None], M)[0] * f
    q = q + rng.normal(0, rng.uniform(0.005, 0.025) * width, (4, 2)).astype(np.float32)
    return img, q.astype(np.float32), {"sleeved": sleeved, "background": str(kind), "cast": str(cast), "card_quad": card_q.astype(np.float32).tolist()}
