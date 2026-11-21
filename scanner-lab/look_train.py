"""The printing look's set-symbol network (LOOK.md), on the graph's own crops (look_gen.py), over every
artwork several English paper printings share.
One item = one artwork: a simulated capture of one printing (shifted crop of its symbol patch) against the
clean symbol of up to MAX of its printings (InfoNCE across the batch, MoCo key encoder). Real-photo eval
uses the graph's centre crops (look_crops.py), so it scores what the exported graph will do.
About 7 minutes for 8 epochs on an M3 Pro's GPU (MPS), 20 Nov 2026. MAXSTEPS ends the run after that many
steps, with that epoch saved and scored (a smoke test). SEED (default 0) seeds Python, NumPy, Torch and the
loader's workers. runs/<run>/run.json records it with the arguments, the groups file's SHA-256, look_gen.py's
manifest (data/look_gen.json), a fingerprint of the crop files (names and contents), and this code's and
the libraries' versions. It uses as many captures per printing as look_gen.py made (its K). The GPU's
own arithmetic isn't bit-for-bit repeatable, so a rerun matches closely, not exactly. Every training
printing must have its crops (look_gen.py); ALLOW_INCOMPLETE=1 trains without the missing ones.
python <lab>/look_train.py RUN [epochs] [batch]"""
import sys, os, json, random, time, hashlib, copy
import numpy as np, torch, torch.nn.functional as F, cv2
from torch.utils.data import Dataset, DataLoader
from look_net import PrintNet, photometric, std
from look_crops import MX, MY, SW, SH, symbol_patch, centre, cases
from paths import REAL

MAX = 6
# Captures per printing: look_gen.py's K, from its manifest (2 when there is none, as on 20 Nov 2026).
K = json.load(open("data/look_gen.json"))["k"] if os.path.exists("data/look_gen.json") else 2


def load(path):
    return cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)


def shifted(patch, rng):
    dy, dx = rng.integers(0, 2 * MY + 1), rng.integers(0, 2 * MX + 1)
    return patch[dy:dy + SH, dx:dx + SW]


def fingerprint(*dirs):
    """SHA-256 over every crop file's name and contents (about 2 GB: a few seconds)."""
    h = hashlib.sha256()
    for d in dirs:
        for e in sorted(os.scandir(d), key=lambda e: e.name):
            h.update(f"{d}/{e.name}\n".encode()); h.update(hashlib.sha256(open(e.path, "rb").read()).digest())
    return h.hexdigest()


def seed_worker(_):
    """Each loader worker's Python and NumPy streams from Torch's per-worker seed (itself from SEED)."""
    seed = torch.initial_seed() % 2 ** 32
    random.seed(seed); np.random.seed(seed)


class Groups(Dataset):
    def __init__(self, groups): self.groups = groups
    def __len__(self): return len(self.groups)
    def __getitem__(self, k):
        rng = np.random.default_rng(np.random.randint(2 ** 31))
        members = self.groups[k][:]; random.shuffle(members); members = members[:MAX]
        q = random.choice(members)
        qimg = photometric(rng, shifted(load(f"data/pq2/{q}_{rng.integers(0, K)}.jpg"), rng))
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
    """Every labelled photo of `cases()`, and a SHA-256 of the cohort (each photo's bytes, label, quad and
    candidates) for run.json; stops if a candidate's clean crop is missing, since dropping the photo would
    make a checkpoint look better only because the cohort shrank."""
    cs = cases()
    missing = sorted({m for _, _, ms in cs for m in ms if not os.path.exists(f"data/pk2/{m}.jpg")})
    if missing:
        raise SystemExit(f"{len(missing)} test candidates have no clean crop in data/pk2 (run look_gen.py again): {missing[:5]}")
    h = hashlib.sha256()  # the cohort's identity: each photo, its label, quad and candidates (no content leaves the lab)
    for r, pid, ms in cs:
        h.update(json.dumps([r["id"], pid, r["quad"], ms]).encode())
        h.update(hashlib.sha256(open(f"{REAL}/{r['id']}.jpg", "rb").read()).digest())
    return [(std(centre(symbol_patch(load(f"{REAL}/{r['id']}.jpg"), json.loads(r["quad"])))), pid, ms) for r, pid, ms in cs], h.hexdigest()


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
    if os.path.isdir(f"runs/{run}") and os.listdir(f"runs/{run}"):
        raise SystemExit(f"runs/{run} already has files: pick a new run name, so no checkpoint of another run is mistaken for this one's.")
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    seed = int(os.environ.get("SEED", 0))
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    raw = open("data/look_groups.json", "rb").read()
    d = json.loads(raw)
    groups, val, missing = [], [], 0
    for g in d["train"]:
        ms = [p["id"] for p in g["printings"] if os.path.exists(f"data/pk2/{p['id']}.jpg") and all(os.path.exists(f"data/pq2/{p['id']}_{k}.jpg") for k in range(K))]
        missing += len(g["printings"]) - len(ms)
        if len(ms) < 2: continue
        (val if int(hashlib.md5(g["ill"].encode()).hexdigest(), 16) % 50 == 0 else groups).append(ms)
    if missing and os.environ.get("ALLOW_INCOMPLETE") != "1":
        raise SystemExit(f"{missing} training printings have no crops: run look_download.py and look_gen.py again, or set ALLOW_INCOMPLETE=1.")
    real, cohort = real_cases()  # stops here, before the run's folder exists, if an input is missing
    import torchvision
    lab = os.path.dirname(os.path.abspath(__file__))
    code = {f: hashlib.sha256(open(os.path.join(lab, f), "rb").read()).hexdigest() for f in ("look_train.py", "look_net.py", "look_crops.py")}
    gen = json.load(open("data/look_gen.json")) if os.path.exists("data/look_gen.json") else None
    os.makedirs(f"runs/{run}", exist_ok=True)
    json.dump({"run": run, "epochs": epochs, "batch": bs, "seed": seed, "captures_per_printing": K, "maxsteps": os.environ.get("MAXSTEPS"),
               "groups_sha256": hashlib.sha256(raw).hexdigest(), "crops_fingerprint": fingerprint("data/pk2", "data/pq2"),
               "look_gen": gen, "code_sha256": code, "torch": torch.__version__, "torchvision": torchvision.__version__,
               "numpy": np.__version__, "opencv": cv2.__version__, "train_groups": len(groups), "held_out": len(val),
               "missing_printings": missing, "real_photos": len(real), "real_cohort_sha256": cohort,
               "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")},
              open(f"runs/{run}/run.json", "w"), indent=1)
    print(f"{len(groups)} training groups ({sum(map(len, groups))} printings), {len(val)} held out, {len(real)} real photos", flush=True)
    model = PrintNet("small").to(dev)
    keyenc = copy.deepcopy(model).eval()
    for p_ in keyenc.parameters(): p_.requires_grad_(False)
    print("before training:", flush=True); evaluate(model, dev, real, val)
    dl = DataLoader(Groups(groups), batch_size=bs, shuffle=True, num_workers=3, collate_fn=collate, drop_last=True,
                    persistent_workers=True, worker_init_fn=seed_worker, generator=torch.Generator().manual_seed(seed))
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
        if step >= int(os.environ.get("MAXSTEPS", 10**9)): break


if __name__ == "__main__":
    main()
