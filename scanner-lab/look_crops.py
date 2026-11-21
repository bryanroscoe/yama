"""The look graph's own crops (look_export.py), in numpy/OpenCV, for training on exactly what the
phone will feed the model. The set symbol's area is cut with a margin (MX, MY pixels at the graph's own
density) so training can shift it; the centre crop at (MX, MY) is the graph's crop."""
import json, os
import numpy as np, cv2
from paths import REAL

SYM = (0.525, 0.605, 0.76, 0.975)  # y0, y1, x0, x1, as look_export.SYM
SW, SH = 160, 80
MX, MY = 19, 12
PW, PH = SW + 2 * MX, SH + 2 * MY


def _homography_xy(quad, us, vs):
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = np.asarray(quad, np.float64)
    dx1, dx2, dx3 = x1 - x2, x3 - x2, x0 - x1 + x2 - x3
    dy1, dy2, dy3 = y1 - y2, y3 - y2, y0 - y1 + y2 - y3
    den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den
    a, b, c = x1 - x0 + g * x1, x3 - x0 + h * x3, x0
    d, e, f = y1 - y0 + g * y1, y3 - y0 + h * y3, y0
    z = g * us + h * vs + 1
    return ((a * us + b * vs + c) / z).astype(np.float32), ((d * us + e * vs + f) / z).astype(np.float32)


def _sample(rgb, quad, us, vs):
    mx, my = _homography_xy(quad, us, vs)
    return cv2.remap(rgb, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


_y0, _y1, _x0, _x1 = SYM
_dx, _dy = (_x1 - _x0) / SW, (_y1 - _y0) / SH
_j, _i = np.meshgrid(np.arange(PW, dtype=np.float64), np.arange(PH, dtype=np.float64))
PATCH_U = _x0 + (_j - MX + 0.5) * _dx
PATCH_V = _y0 + (_i - MY + 0.5) * _dy
_j, _i = np.meshgrid(np.arange(320, dtype=np.float64), np.arange(448, dtype=np.float64))
CARD_U, CARD_V = _j / 320, _i / 448


def corners(rgb):
    h, w = rgb.shape[:2]
    return [[0, 0], [w, 0], [w, h], [0, h]]


def symbol_patch(rgb, quad):
    """PH x PW: the symbol's area with its margin."""
    return _sample(rgb, quad, PATCH_U, PATCH_V)


def card_view(rgb, quad):
    """448 x 320: the whole card, as the graph's card branch."""
    return _sample(rgb, quad, CARD_U, CARD_V)


def centre(patch):
    return patch[MY:MY + SH, MX:MX + SW]


def cases(groups="data/look_groups.json"):
    """The labelled real photos whose artwork several printings share: (manifest row, its printing, the
    printings of its artwork that have an image in data/printings)."""
    d = json.load(open(groups))
    ill_of, by_ill = {}, {}
    for g in d["test"]:
        by_ill[g["ill"]] = [p["id"] for p in g["printings"]]
        for p in g["printings"]: ill_of[p["id"]] = g["ill"]
    out = []
    for line in open(f"{REAL}/manifest.jsonl"):
        r = json.loads(line); pid = r.get("label_scryfall_id")
        if not pid or pid not in ill_of: continue
        ms = [m for m in by_ill[ill_of[pid]] if os.path.exists(f"data/printings/{m}.jpg")]
        if len(ms) >= 2 and pid in ms: out.append((r, pid, ms))
    return out


_twins = {}


def strict_twin(a, b):
    """Two printings whose clean scans are the same picture (grey correlation over 0.97, whole card) with
    the same set-symbol area (over 0.95, the graph's crop): only the collector number tells them apart."""
    k = tuple(sorted((a, b)))
    if k not in _twins:
        def grey(p, symbol):
            x = cv2.cvtColor(cv2.imread(f"data/printings/{p}.jpg"), cv2.COLOR_BGR2RGB)
            x = centre(symbol_patch(x, corners(x))) if symbol else cv2.resize(x, (244, 340), interpolation=cv2.INTER_AREA)
            x = cv2.cvtColor(x, cv2.COLOR_RGB2GRAY).astype(np.float32)
            return (x - x.mean()) / (x.std() + 1e-3)
        _twins[k] = float((grey(a, False) * grey(b, False)).mean()) > 0.97 and float((grey(a, True) * grey(b, True)).mean()) > 0.95
    return _twins[k]
