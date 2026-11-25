"""Simulated phone captures of a card tossed onto a pile of others (Bryan, 24 Nov 2026: "identify cards and
stacks of cards as you're tossing them on top of each other, as well as identify their borders better").
Nothing covers the card on top (though, up to 0.72 of the frame's height and turned, it may run off the frame's
edge); the ones under it peek out around it at other offsets and turns, sleeved alike or not, now and then
face down, each casting a soft shadow on what's beneath. The camera looks down on
the pile from a small tilt, with sim.py's light and optics (sim.capture), and the frame is the
recognizer's (640 x 1138, upright). Labels: the top card's corners as printed (TL, TR, BR, BL).

render_pile(top_rgb, under_rgbs, rng, level) -> (frame uint8 H x W x 3, quad 4 x 2, meta)
"""
import cv2
import numpy as np

import sim

FRAME = (640, 1138)
# How many cards lie under the top one: none (a card on the table), a few, a real pile.
UNDER = ([0, 1, 2, 3, 5, 8], [0.12, 0.3, 0.2, 0.14, 0.14, 0.1])


def card_back(h, w, rng):
    """A card back drawn flat: a dark olive-brown frame and an orange-brown oval (no artwork)."""
    img = np.empty((h, w, 3), np.float32)
    img[:] = np.array([0.28, 0.2, 0.1]) * rng.uniform(0.8, 1.2)
    cv2.ellipse(img, (w // 2, h // 2), (int(w * 0.41), int(h * 0.43)), 0, 0, 360, (0.66, 0.4, 0.16), -1)
    img += sim.smooth_field(rng, h, w, 6)[..., None] * 0.08 - 0.04
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def corners(w, h, cx, cy, deg):
    a = np.deg2rad(deg)
    pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], np.float32)
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]], np.float32)
    return pts @ R.T + np.float32([cx, cy])


def box(quad, shape, pad):
    """The part of a scene `shape` that `quad` covers, `pad` px around it: (x0, y0, x1, y1), or None."""
    h, w = shape[:2]
    x0, y0 = np.floor(quad.min(0) - pad).astype(int)
    x1, y1 = np.ceil(quad.max(0) + pad).astype(int)
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def place(scene, unit, quad, alpha):
    """sim.place, only over the box the card covers (the same pixels, far fewer blended)."""
    b = box(quad, scene.shape, 2)
    if b is None:
        return scene, None
    x0, y0, x1, y1 = b
    h, w = unit.shape[:2]
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), np.float32(quad - [x0, y0]))
    warped = cv2.warpPerspective(unit, M, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR)
    wa = cv2.warpPerspective(alpha, M, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR)[..., None]
    region = scene[y0:y1, x0:x1]
    scene[y0:y1, x0:x1] = region * (1 - wa) + warped * wa
    return scene, np.float64([[1, 0, x0], [0, 1, y0], [0, 0, 1]]) @ M


def shadow(scene, quad, rng, size):
    """The soft shadow a card lying on the pile casts on what's beneath, a little off to one side."""
    off = rng.uniform(0.004, 0.02, 2) * size * rng.choice([-1.0, 1.0], 2)
    sigma = max(1.0, 0.012 * size)
    strength = rng.uniform(0.15, 0.45)
    b = box(quad + off, scene.shape, 4 * sigma)
    if b is None:
        return scene
    x0, y0, x1, y1 = b
    m = np.zeros((y1 - y0, x1 - x0), np.float32)
    cv2.fillConvexPoly(m, np.round((quad + off - [x0, y0]) * 4).astype(np.int32), 1.0, lineType=cv2.LINE_AA, shift=2)
    m = cv2.GaussianBlur(m, (0, 0), sigma)
    scene[y0:y1, x0:x1] *= (1 - strength * m[..., None]).astype(np.float32)
    return scene


def playmat(rng, art_rgb, h, w):
    """A playmat: a card's artwork (its art box, not its frame) blown up, soft and darkened, under the pile."""
    ah, aw = art_rgb.shape[:2]
    art = art_rgb[int(0.12 * ah):int(0.55 * ah), int(0.09 * aw):int(0.91 * aw)]
    x = cv2.resize(art, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255
    x = cv2.GaussianBlur(x, (0, 0), rng.uniform(2, 8))
    return np.clip(x * rng.uniform(0.35, 0.8), 0, 1)


def render_pile(top_rgb, under_rgbs, rng, level=1.0, frame=FRAME):
    """`under_rgbs`: the cards beneath, deepest first (any number, none included)."""
    L = level
    Wf, Hf = frame
    Wk, Hk = 2 * Wf, 2 * Hf  # sim's working scale: twice the recognizer's
    m = int(0.12 * Wk)  # room past the frame, so the camera's tilt never shows an edge
    final_h = rng.uniform(0.3, 0.72) * Hf
    work_h = int(final_h * 2)
    # The pile sleeved alike (when the top card is sleeved). A grey sleeve (sim.py's `None` colour) draws its shade
    # afresh for each card, so those piles are alike in kind only: kept so, as the shipped finder was trained on it.
    deck = rng.random() < 0.6
    top, top_a, u = sim.card_unit(top_rgb, rng, L, work_h, 0.75)
    sh, sw = top.shape[:2]

    if under_rgbs and rng.random() < 0.25:
        scene, kind = playmat(rng, under_rgbs[0], Hk + 2 * m, Wk + 2 * m), "playmat"
    else:
        scene, kind = sim.background(rng, Hk + 2 * m, Wk + 2 * m)
    scene = np.ascontiguousarray(scene, np.float32)
    cx, cy = m + Wk / 2 + rng.uniform(-0.15, 0.15) * Wk, m + Hk / 2 + rng.uniform(-0.12, 0.12) * Hk
    r = rng.random()
    ang = rng.normal(0, 10) if r < 0.6 else rng.uniform(-180, 180) if r < 0.85 else rng.choice([-90.0, 90.0]) + rng.normal(0, 8)

    backs = 0
    for img in under_rgbs:
        if rng.random() < 0.08:
            img = card_back(img.shape[0], img.shape[1], rng)
            backs += 1
        alike = deck and u["sleeved"]
        # Drawn at half the top card's resolution: they're mostly covered, and the pile is most of the cost.
        unit, a, _ = sim.card_unit(img, rng, L, work_h // 2, 1.0 if alike else 0.4, colour=u["colour"] if alike else "draw")
        d = rng.normal(0, rng.uniform(0.04, 0.25), 2) * [sw, sh]
        d = np.clip(d, [-0.55 * sw, -0.55 * sh], [0.55 * sw, 0.55 * sh])
        turn = rng.normal(0, 10) if rng.random() < 0.7 else rng.uniform(-40, 40)
        if rng.random() < 0.05:
            turn += rng.choice([-90.0, 90.0])
        q = corners(sw, sh, cx + d[0], cy + d[1], ang + turn)
        if rng.random() < 0.8:
            scene = shadow(scene, q, rng, sw)
        scene, _ = place(scene, unit, q, a)

    q = corners(sw, sh, cx, cy, ang)
    if under_rgbs or rng.random() < 0.5:
        scene = shadow(scene, q, rng, sw)
    scene, M = place(scene, top, q, top_a)
    p, ww, wh = u["pad"], u["work_w"], u["work_h"]
    card_q = cv2.perspectiveTransform(np.float32([[p, p], [p + ww, p], [p + ww, p + wh], [p, p + wh]])[None], M)[0]

    # The camera a little off square to the table: the frame's corners land near the table's.
    dst = np.float32([[0, 0], [Wk, 0], [Wk, Hk], [0, Hk]])
    src = dst + m + np.clip(rng.normal(0, 0.03 * Wk * L, (4, 2)), -0.9 * m, 0.9 * m).astype(np.float32)
    T = cv2.getPerspectiveTransform(src, dst)
    scene = cv2.warpPerspective(scene, T, (Wk, Hk), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    card_q = cv2.perspectiveTransform(card_q[None], T)[0]

    img, cast = sim.capture(scene, rng, L)
    interp = cv2.INTER_AREA if rng.random() < 0.5 else cv2.INTER_LINEAR
    img = cv2.resize(img, (Wf, Hf), interpolation=interp)
    return img, (card_q * 0.5).astype(np.float32), {"under": len(under_rgbs), "backs": backs, "sleeved": u["sleeved"], "background": str(kind), "cast": str(cast)}


def draw_under(rng, cards, n=None):
    """How many cards lie under the top one (UNDER), and which (paths from `cards`)."""
    n = int(rng.choice(UNDER[0], p=UNDER[1])) if n is None else n
    return [cards[rng.integers(len(cards))] for _ in range(n)]
