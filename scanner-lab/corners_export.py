"""Export a corner checkpoint as a drop-in for the bundle's detector.onnx: input `window` uint8 256 x 256 x 4
(RGBA), outputs `quad` 4 x 2 (window px, top-left as printed first), `up` 2 (its length over 4 is the vote:
here 4 x the presence probability), `centre` 2 and `short` (the bundle's formula), so recognizer.ts runs it
unchanged. python <lab>/corners_export.py CKPT OUT.onnx"""
import sys, os
import torch, torch.nn as nn
from corners_train import Corners, MEAN, STD

ASPECT = 1.3968253968253967  # the bundle's card_aspect


class Exported(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        self.register_buffer("mean", MEAN); self.register_buffer("std", STD)

    def forward(self, window):
        x = window[:, :, :3].permute(2, 0, 1).unsqueeze(0).float() / 255
        corners, _, plog = self.model((x - self.mean) / self.std)
        q = corners[0]
        p = torch.sigmoid(plog)
        e = (torch.roll(q, -1, 0) - q).norm(dim=-1)
        a, b = e[0] + e[2], e[1] + e[3]
        short = (torch.minimum(a, b) / 2 + torch.maximum(a, b) / 2 / ASPECT) / 2
        up = torch.stack([torch.zeros_like(p[0]), -4 * p[0]])
        return q, up, q.mean(0), short


if __name__ == "__main__":
    ckpt, out = sys.argv[1], sys.argv[2]
    m = Corners(pretrained=False); m.load_state_dict(torch.load(ckpt, map_location="cpu")); m.eval()
    torch.onnx.export(Exported(m).eval(), (torch.zeros(256, 256, 4, dtype=torch.uint8),), out, input_names=["window"],
                      output_names=["quad", "up", "centre", "short"], opset_version=17, dynamo=False)
    print(out, os.path.getsize(out))
