"""Yama's corner detector: one view of the 256 px window (the bundle's runs four), the card's corners as
printed, covered ones included. torchvision MobileNetV3-Small (BSD-3, ImageNet weights) and a small FPN to
stride 4; each corner is a softmax-weighted vote of cells (their centre plus an offset), so a covered corner
or one past the window's edge is still placed. A pooled head says whether a card is there.
python <lab>/corners_train.py RUN EPOCHS [LR [INIT.pt]]   (from the work directory: data/corners/{train,val}, or
CORNERS_DATA; ROOTS=train,train_photo trains on several folders; VALS=val,pile_val validates on each; INIT.pt
fine-tunes; writes runs/RUN/epN.pt)"""
import sys, os, json, glob, time, math
import numpy as np, cv2, torch, torch.nn as nn, torch.nn.functional as F
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights

S, STRIDE, OFF = 256, 4, 32.0
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)


def block(cin, cout):
    return nn.Sequential(nn.Conv2d(cin, cin, 3, padding=1, groups=cin, bias=False), nn.BatchNorm2d(cin), nn.Hardswish(),
                         nn.Conv2d(cin, cout, 1, bias=False), nn.BatchNorm2d(cout), nn.Hardswish())


class Corners(nn.Module):
    def __init__(self, pretrained=True, C=64):
        super().__init__()
        f = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None).features
        self.s4, self.s8, self.s16, self.s32 = f[:2], f[2:4], f[4:9], f[9:]
        self.l4, self.l8, self.l16, self.l32 = (nn.Conv2d(c, C, 1) for c in (16, 24, 48, 576))
        self.m16, self.m8, self.m4 = block(C, C), block(C, C), block(C, C)
        self.head = nn.Conv2d(C, 12, 1)  # per corner: logit, dx, dy
        self.present = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(576, 64), nn.Hardswish(), nn.Linear(64, 1))
        n = S // STRIDE
        ys, xs = torch.meshgrid(torch.arange(n), torch.arange(n), indexing="ij")
        self.register_buffer("cells", torch.stack([(xs + 0.5) * STRIDE, (ys + 0.5) * STRIDE], -1).view(1, 1, n * n, 2).float())

    def forward(self, x):
        """x: B x 3 x S x S normalised. Returns corners B x 4 x 2 (px), logits B x 4 x N, presence logit B."""
        a = self.s4(x); b = self.s8(a); c = self.s16(b); d = self.s32(c)
        p = self.l32(d)
        p = self.m16(self.l16(c) + F.interpolate(p, scale_factor=2, mode="nearest"))
        p = self.m8(self.l8(b) + F.interpolate(p, scale_factor=2, mode="nearest"))
        p = self.m4(self.l4(a) + F.interpolate(p, scale_factor=2, mode="nearest"))
        h = self.head(p)
        B, _, H, W = h.shape
        h = h.view(B, 4, 3, H * W)
        logits = h[:, :, 0]
        off = h[:, :, 1:].permute(0, 1, 3, 2) * OFF  # B x 4 x N x 2
        w = torch.softmax(logits, -1).unsqueeze(-1)
        corners = (w * (self.cells + off)).sum(2)
        return corners, logits, self.present(d).squeeze(1)


class Windows(torch.utils.data.Dataset):
    def __init__(self, roots, train):
        self.train = train
        self.rows = [dict(r, root=root) for root in roots.split(",") for f in sorted(glob.glob(f"{root}/labels_*.json")) for r in json.load(open(f))]

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        img = cv2.cvtColor(cv2.imread(f"{r['root']}/{r['file']}"), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
        q = np.float32(r["quad"]) if r["quad"] else np.zeros((4, 2), np.float32)
        if self.train:  # light photometric jitter on top of the simulator's, and a quarter turn or more
            img = np.clip((img - 0.5) * np.random.uniform(0.8, 1.2) + 0.5 + np.random.uniform(-0.08, 0.08), 0, 1)
            for _ in range(np.random.randint(4)):  # np.rot90 turns anticlockwise: (x, y) -> (y, S - x)
                img = np.ascontiguousarray(np.rot90(img))
                q = np.stack([q[:, 1], S - q[:, 0]], 1).astype(np.float32)
        return torch.from_numpy(img).permute(2, 0, 1), torch.from_numpy(q), torch.tensor(float(r["present"])), torch.tensor(float(r["quad"] is not None))


def target_map(q, n):
    """A Gaussian (1.5 cells) at each corner, clamped into the grid, as a distribution over the N cells."""
    g = (q / STRIDE - 0.5).clamp(0, n - 1)  # B x 4 x 2 in cell units
    ys = torch.arange(n, device=q.device).float(); xs = ys
    dx = (xs.view(1, 1, 1, n) - g[..., 0:1].unsqueeze(-1)) ** 2
    dy = (ys.view(1, 1, n, 1) - g[..., 1:2].unsqueeze(-1)) ** 2
    t = torch.exp(-(dx + dy) / (2 * 1.5 ** 2)).view(q.shape[0], 4, n * n)
    return t / t.sum(-1, keepdim=True)


def losses(model, x, q, present, has_quad):
    corners, logits, plog = model(x)
    n = S // STRIDE
    m = has_quad.view(-1, 1)
    l1 = ((corners - q).abs().sum(-1) / S * m).sum() / (m.sum() * 4 + 1e-6)
    ce = (-(target_map(q, n) * F.log_softmax(logits, -1)).sum(-1) * m).sum() / (m.sum() * 4 + 1e-6)
    bce = F.binary_cross_entropy_with_logits(plog, present)
    return l1 + 0.2 * ce + 0.3 * bce, (l1.item(), ce.item(), bce.item()), corners, plog


def main():
    run, epochs = sys.argv[1], int(sys.argv[2])
    lr = float(sys.argv[3]) if len(sys.argv) > 3 else 2e-3
    out = f"runs/{run}"; os.makedirs(out, exist_ok=True)
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    D = os.environ.get("CORNERS_DATA", "data/corners")
    tr = Windows(",".join(f"{D}/{x}" for x in os.environ.get("ROOTS", "train").split(",")), True)
    vals = [(v, Windows(f"{D}/{v}", False)) for v in os.environ.get("VALS", "val").split(",")]
    dl = torch.utils.data.DataLoader(tr, batch_size=96, shuffle=True, num_workers=4, drop_last=True, persistent_workers=True)
    model = Corners()
    if len(sys.argv) > 4:  # fine-tune from a checkpoint
        model.load_state_dict(torch.load(sys.argv[4], map_location="cpu"))
    model = model.to(dev)
    mean, std = MEAN.to(dev), STD.to(dev)
    back = [p for n_, p in model.named_parameters() if n_.startswith("s")]
    rest = [p for n_, p in model.named_parameters() if not n_.startswith("s")]
    opt = torch.optim.AdamW([{"params": back, "lr": lr * 0.5}, {"params": rest, "lr": lr}], weight_decay=1e-4)
    total = epochs * len(dl); warm = 300 if len(sys.argv) <= 4 else 50
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(s, total) / total)))
    print(f"train {len(tr)} val {', '.join(f'{v} {len(va)}' for v, va in vals)} steps/epoch {len(dl)} on {dev}", flush=True)
    for ep in range(epochs):
        model.train(); t0 = time.time(); acc = np.zeros(3); k = 0
        for x, q, present, has in dl:
            x, q, present, has = x.to(dev), q.to(dev), present.to(dev), has.to(dev)
            loss, parts, _, _ = losses(model, (x - mean) / std, q, present, has)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step()
            acc += parts; k += 1
        model.eval(); report = []
        for v, va in vals:
            errs = []; hits = 0; tot = 0
            with torch.no_grad():
                for x, q, present, has in torch.utils.data.DataLoader(va, batch_size=96, shuffle=False, num_workers=2):
                    x, q, present, has = x.to(dev), q.to(dev), present.to(dev), has.to(dev)
                    corners, _, plog = model((x - mean) / std)
                    hits += ((plog > 0).float() == present).sum().item(); tot += len(present)
                    side = torch.minimum((q[:, 1] - q[:, 0]).norm(dim=-1), (q[:, 2] - q[:, 1]).norm(dim=-1))
                    e = ((corners - q).norm(dim=-1).mean(-1) / side.clamp(min=1))[present > 0]
                    errs += e.cpu().tolist()
            errs = np.array(errs)
            report.append(f"{v} corner error / short side median {np.median(errs):.3%} p90 {np.percentile(errs, 90):.3%} | present acc {hits/tot:.2%}")
        print(f"ep {ep}: train l1 {acc[0]/k:.4f} ce {acc[1]/k:.3f} bce {acc[2]/k:.3f} | {' | '.join(report)} | {time.time()-t0:.0f}s", flush=True)
        torch.save(model.state_dict(), f"{out}/ep{ep}.pt")


if __name__ == "__main__":
    main()
