"""The printing look's set-symbol network (LOOK.md), on the graph's own crops (look_gen.py), over every
artwork several English paper printings share.
One item = one artwork: a simulated capture of one printing (shifted crop of its symbol patch) against the
clean symbol of up to MAX of its printings (InfoNCE across the batch, MoCo key encoder). Real-photo eval
uses the graph's centre crops (look_crops.py), so it scores what the exported graph will do.
About 7 minutes for 8 epochs on an M3 Pro's GPU (MPS), 20 Nov 2026. MAXSTEPS stops early (a smoke test).
python <lab>/look_train.py RUN [epochs] [batch]"""
import sys, os, json, random, time, hashlib, copy
import numpy as np, torch, torch.nn.functional as F, cv2
from torch.utils.data import Dataset, DataLoader
from look_net import PrintNet, photometric, std
from look_crops import MX, MY, SW, SH, symbol_patch, centre, cases
from paths import REAL

MAX = 6


def load(path):
    return cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)


def shifted(patch, rng):
    dy, dx = rng.integers(0, 2 * MY + 1), rng.integers(0, 2 * MX + 1)
    return patch[dy:dy + SH, dx:dx + SW]


class Groups(Dataset):
    def __init__(self, groups): self.groups = groups
    def __len__(self): return len(self.groups)
    def __getitem__(self, k):
        rng = np.random.default_rng()
        members = self.groups[k][:]; random.shuffle(members); members = members[:MAX]
        q = random.choice(members)
        qimg = photometric(rng, shifted(load(f"data/pq2/{q}_{rng.integers(0, 2)}.jpg"), rng))
        keys = []
        for m in members:
            c = centre(load(f"data/pk2/{m}.jpg"))
            keys.append(std(photometric(rng, c) if rng.random() < 0.5 else c))
        valid = [True] * len(keys) + [False] * (MAX - len(keys))
        keys += [keys[0]] * (MAX - len(keys))
        return std(qimg), torch.stack(keys), members.index(q), torch.tensor(valid)


def collate(batch):
    qs = torch.stack([b[0] for b in batch]); keys = torch.cat([b[1] for b in batch])
    target = torch.tensor([i * MAX + b[2] for i, b in enumerate(batch)])
    return qs, keys, target, torch.cat([b[3] for b in batch])


@torch.no_grad()
def embed(model, tensors, dev, bs=64):
    out = []
    for i in range(0, len(tensors), bs):
        chunk = tensors[i:i + bs]; n = len(chunk); chunk = chunk + [chunk[0]] * (bs - n)
        out.append(model(torch.stack(chunk).to(dev)).float().cpu()[:n])
    return torch.cat(out) if out else torch.zeros(0, 128)


def real_cases():
    out = []
    for r, pid, ms in cases():
        if not all(os.path.exists(f"data/pk2/{m}.jpg") for m in ms): continue
        out.append((std(centre(symbol_patch(load(f"{REAL}/{r['id']}.jpg"), json.loads(r["quad"])))), pid, ms))
    return out


def evaluate(model, dev, real, val):
    model.eval()
    ids = sorted({m for _, _, ms in real for m in ms})
    keys = {} if not ids else dict(zip(ids, embed(model, [std(centre(load(f"data/pk2/{m}.jpg"))) for m in ids], dev)))
    qs = embed(model, [c[0] for c in real], dev)
    right = sum(ms[int((torch.stack([keys[m] for m in ms]) @ e).argmax())] == pid for e, (_, pid, ms) in zip(qs, real))
    # Simulated held-out artworks: capture 0's centre crop among its group.
    vq, vk, vg = [], [], []
    for g in val:
        q = g[0]; vq.append(std(centre(load(f"data/pq2/{q}_0.jpg")))); vg.append(g)
    vids = sorted({m for g in val for m in g})
    vkeys = dict(zip(vids, embed(model, [std(centre(load(f"data/pk2/{m}.jpg"))) for m in vids], dev)))
    vqs = embed(model, vq, dev)
    vright = sum(g[int((torch.stack([vkeys[m] for m in g]) @ e).argmax())] == g[0] for e, g in zip(vqs, vg))
    model.train()
    print(f"  real: exact {right}/{len(real)} = {right / max(len(real), 1):.1%}   simulated held-out: exact {vright}/{len(val)} = {vright / max(len(val), 1):.1%}", flush=True)
    return right / max(len(real), 1)


def main():
    run = sys.argv[1]; epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 8; bs = int(sys.argv[3]) if len(sys.argv) > 3 else 64
    os.makedirs(f"runs/{run}", exist_ok=True)
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    d = json.load(open("data/look_groups.json"))
    groups, val = [], []
    for g in d["train"]:
        ms = [p["id"] for p in g["printings"] if os.path.exists(f"data/pk2/{p['id']}.jpg") and os.path.exists(f"data/pq2/{p['id']}_1.jpg")]
        if len(ms) < 2: continue
        (val if int(hashlib.md5(g["ill"].encode()).hexdigest(), 16) % 50 == 0 else groups).append(ms)
    real = real_cases()
    print(f"{len(groups)} training groups ({sum(map(len, groups))} printings), {len(val)} held out, {len(real)} real photos", flush=True)
    model = PrintNet("small").to(dev)
    keyenc = copy.deepcopy(model).eval()
    for p_ in keyenc.parameters(): p_.requires_grad_(False)
    print("before training:", flush=True); evaluate(model, dev, real, val)
    dl = DataLoader(Groups(groups), batch_size=bs, shuffle=True, num_workers=3, collate_fn=collate, drop_last=True, persistent_workers=True)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    steps = epochs * len(dl)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-4, total_steps=steps, pct_start=0.05)
    step, t0 = 0, time.time()
    for ep in range(epochs):
        tot = n = 0
        for qs, keys, target, valid in dl:
            qs, keys, target, valid = qs.to(dev), keys.to(dev), target.to(dev), valid.to(dev)
            with torch.autocast("mps", dtype=torch.float16, enabled=dev.type == "mps"):
                eq = model(qs).float()
                with torch.no_grad(): ek = keyenc(keys).float()
            logits = (eq @ ek.T / 0.05).masked_fill(~valid[None, :], -1e4)
            loss = F.cross_entropy(logits, target)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step(); step += 1
            with torch.no_grad():
                for pk, pq in zip(keyenc.parameters(), model.parameters()): pk.mul_(0.99).add_(pq.detach(), alpha=0.01)
                for bk, bq in zip(keyenc.buffers(), model.buffers()): bk.copy_(bq)  # BN statistics follow too (20 Nov fix)
            tot += loss.item(); n += 1
            if step >= int(os.environ.get("MAXSTEPS", 10**9)): break
            if step % 50 == 0: print(f"ep {ep} step {step}/{steps} loss {tot / n:.3f} {(time.time() - t0) / step:.2f}s/step", flush=True)
        torch.save(model.state_dict(), f"runs/{run}/ep{ep}.pt")
        print(f"epoch {ep} loss {tot / max(n, 1):.3f}", flush=True)
        evaluate(model, dev, real, val)


if __name__ == "__main__":
    main()
