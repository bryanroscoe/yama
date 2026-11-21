"""The printing look's network and its augmentations (LOOK.md): MobileNetV3 (torchvision's ImageNet
weights, BSD-3-Clause) -> GeM pooling -> 128 numbers, L2-normalised. One network per view: the set
symbol's area (160 x 80) and the whole card (320 x 448)."""
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F


class PrintNet(nn.Module):
    def __init__(self, arch="small", dim=128):
        super().__init__()
        from torchvision.models import mobilenet_v3_large, mobilenet_v3_small, MobileNet_V3_Large_Weights, MobileNet_V3_Small_Weights
        if arch == "large":
            self.features = mobilenet_v3_large(weights=MobileNet_V3_Large_Weights.IMAGENET1K_V2).features; c = 960
        else:
            self.features = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1).features; c = 576
        self.p = nn.Parameter(torch.tensor(3.0))
        self.head = nn.Linear(c, dim)

    def forward(self, x):
        f = self.features(x).clamp(min=1e-6)
        f = f.pow(self.p).mean((2, 3)).pow(1 / self.p)  # GeM
        return F.normalize(self.head(f), dim=1)


def photometric(rng, img):
    """Haze, gamma, a cast and sometimes grey: what a sleeve and a room do to a card's look."""
    x = img.astype(np.float32) / 255
    if rng.random() < 0.6:
        h = rng.uniform(0, 0.45); x = x * (1 - h) + h * rng.uniform(0.8, 1.0)
    x = np.clip(x, 0, 1) ** rng.uniform(0.7, 1.4)
    x = x * rng.uniform(0.8, 1.2, 3)
    if rng.random() < 0.2:
        x = np.repeat(x.mean(2, keepdims=True), 3, 2)
    return (np.clip(x, 0, 1) * 255).astype(np.uint8)


def std(img):
    """Each channel of one image to mean 0, sd 1, as the exported graph does: overall tone (a hazy
    sleeve, a pale scan) never tells printings apart. HWC uint8 in, CHW float tensor out."""
    x = img.astype(np.float32) / 255
    x = (x - x.mean((0, 1))) / (x.std((0, 1)) + 1e-3)
    return torch.from_numpy(x.transpose(2, 0, 1).copy())
