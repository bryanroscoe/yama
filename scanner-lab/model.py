"""The bundle's embedder (MobileNetV3-Small, BN folded into convs, 576->128 head, L2 norm) as PyTorch,
loaded from models/back.onnx by layer name."""
import torch, torch.nn as nn, torch.nn.functional as F, onnx
from onnx import numpy_helper
from torchvision.models import mobilenet_v3_small

def _fold(module: nn.Module):
    for name, child in list(module.named_children()):
        if isinstance(child, nn.BatchNorm2d):
            setattr(module, name, nn.Identity())
        elif isinstance(child, nn.Conv2d) and child.bias is None:
            c = nn.Conv2d(child.in_channels, child.out_channels, child.kernel_size, child.stride, child.padding, child.dilation, child.groups, bias=True)
            setattr(module, name, c)
        else:
            _fold(child)

class Embedder(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = mobilenet_v3_small().features
        _fold(self.features)
        self.head = nn.Linear(576, 128)
    def forward(self, x):
        x = self.features(x).mean((2, 3))
        return F.normalize(self.head(x), dim=1, eps=1e-12)

def load_bundle_embedder(path="models/back.onnx") -> Embedder:
    m = onnx.load(path)
    init = {t.name: torch.from_numpy(numpy_helper.to_array(t).copy()) for t in m.graph.initializer}
    e = Embedder()
    mods = dict(e.named_modules())
    n = 0
    for node in m.graph.node:
        if node.op_type == "Conv":
            segs, parts, prev = node.name.removeprefix("/embedder/").removesuffix("/Conv").split("/"), [], None
            for seg in segs:
                parts.append(seg[len(prev) + 1:] if prev and seg.startswith(prev + ".") else seg); prev = seg
            conv = mods[".".join(parts)]
            conv.weight.data.copy_(init[node.input[1]]); conv.bias.data.copy_(init[node.input[2]]); n += 1
    e.head.weight.data.copy_(init["embedder.head.weight"]); e.head.bias.data.copy_(init["embedder.head.bias"])
    assert n == 52, n
    return e
