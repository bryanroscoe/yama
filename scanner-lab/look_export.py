"""The printing look model as one ONNX graph with the art model's interface: scene (H x W x 4 uint8 RGBA)
and quad (4 x 2, the card's corners top-left first, in scene pixels) in; `symbol` and `card` (1 x 128, L2
normalised) out. The graph warps the card itself (bilinear GridSample, like the bundle's embed.onnx):
the set symbol's area (card y 0.525-0.605, x 0.76-0.975) to 160 x 80 and the whole card to 320 x 448,
standardises each channel of each image (mean 0, sd 1), and runs the two PrintNets.
A clean Scryfall image is embedded with quad = its corners [[0,0],[w,0],[w,h],[0,h]].
python <lab>/look_export.py SYM_CKPT CARD_CKPT OUT.onnx"""
import sys, os
import torch, torch.nn as nn, torch.nn.functional as F

SYM = (0.525, 0.605, 0.76, 0.975)  # y0, y1, x0, x1


def homography_grid(quad, us, vs, h, w):
    """Map card coordinates (us, vs in [0,1], each 2-D) through the unit-square-to-quad homography to
    grid_sample's normalised coordinates. Heckbert's closed form: no solve, no branch."""
    x0, y0 = quad[0, 0], quad[0, 1]; x1, y1 = quad[1, 0], quad[1, 1]
    x2, y2 = quad[2, 0], quad[2, 1]; x3, y3 = quad[3, 0], quad[3, 1]
    dx1, dx2, dx3 = x1 - x2, x3 - x2, x0 - x1 + x2 - x3
    dy1, dy2, dy3 = y1 - y2, y3 - y2, y0 - y1 + y2 - y3
    den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den
    hh = (dx1 * dy3 - dx3 * dy1) / den
    a, b, c = x1 - x0 + g * x1, x3 - x0 + hh * x3, x0
    d, e, f = y1 - y0 + g * y1, y3 - y0 + hh * y3, y0
    z = g * us + hh * vs + 1
    x = (a * us + b * vs + c) / z; y = (d * us + e * vs + f) / z
    return torch.stack([2 * x / (w - 1) - 1, 2 * y / (h - 1) - 1], -1)[None]


def standardise(img):
    m = img.mean((2, 3), keepdim=True)
    s = ((img - m) ** 2).mean((2, 3), keepdim=True).sqrt()
    return (img - m) / (s + 1e-3)


class Look(nn.Module):
    def __init__(self, sym, card):
        super().__init__()
        self.sym, self.card = sym, card
        y0, y1, x0, x1 = SYM
        i, j = torch.meshgrid(torch.arange(80, dtype=torch.float32), torch.arange(160, dtype=torch.float32), indexing="ij")
        self.register_buffer("su", x0 + (j + 0.5) / 160 * (x1 - x0)); self.register_buffer("sv", y0 + (i + 0.5) / 80 * (y1 - y0))
        i, j = torch.meshgrid(torch.arange(448, dtype=torch.float32), torch.arange(320, dtype=torch.float32), indexing="ij")
        self.register_buffer("cu", j / 320); self.register_buffer("cv", i / 448)

    def forward(self, scene, quad):
        h = scene.shape[0]; w = scene.shape[1]
        img = scene[:, :, :3].permute(2, 0, 1)[None].float() / 255
        hf, wf = torch.tensor(h, dtype=torch.float32), torch.tensor(w, dtype=torch.float32)
        s = F.grid_sample(img, homography_grid(quad, self.su, self.sv, hf, wf), mode="bilinear", padding_mode="zeros", align_corners=True)
        c = F.grid_sample(img, homography_grid(quad, self.cu, self.cv, hf, wf), mode="bilinear", padding_mode="zeros", align_corners=True)
        return self.sym(standardise(s)), self.card(standardise(c))


def build(sym_ckpt, card_ckpt):
    from look_net import PrintNet
    sym = PrintNet("small", pretrained=False); sym.load_state_dict(torch.load(sym_ckpt, map_location="cpu"))
    card = PrintNet("small", pretrained=False); card.load_state_dict(torch.load(card_ckpt, map_location="cpu"))
    return Look(sym, card).eval()


if __name__ == "__main__":
    sym_ckpt, card_ckpt, out = sys.argv[1:4]
    m = build(sym_ckpt, card_ckpt)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    scene = torch.zeros(640, 480, 4, dtype=torch.uint8); quad = torch.tensor([[40., 40], [440, 50], [430, 600], [30, 590]])
    torch.onnx.export(m, (scene, quad), out, input_names=["scene", "quad"], output_names=["symbol", "card"],
                      dynamic_axes={"scene": {0: "height", 1: "width"}}, opset_version=17, dynamo=False)
    import onnx, onnxruntime as ort, numpy as np
    onnx.checker.check_model(onnx.load(out))
    rng = np.random.default_rng(0); sc = rng.integers(0, 255, (700, 500, 4), dtype=np.uint8)
    q = np.float32([[60, 50], [450, 70], [430, 650], [40, 630]])
    a = ort.InferenceSession(out).run(None, {"scene": sc, "quad": q})
    with torch.no_grad(): b = m(torch.from_numpy(sc), torch.from_numpy(q))
    print(out, os.path.getsize(out), "bytes; max diff vs torch", max(float(np.abs(x - y.numpy()).max()) for x, y in zip(a, b)))
