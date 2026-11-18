"""Fine-tune the scanner's query embedder on simulated sleeved/glare captures, against the bundle's
frozen gallery vectors (so the art index, the search graph and the server's supplement job stay as
they are; only the phone's embed graph changes).

Loss: CosFace over every gallery artwork (the real-photo test cards masked out), s=SCALE, margin M.
python <lab>/train.py RUN_NAME [epochs] [lr]   (yama-art-20261118: art1 8 2e-4, epoch 6)
"""
import sys, os, glob, time, json, hashlib
import numpy as np, torch, torch.nn.functional as F, cv2
from torch.utils.data import Dataset, DataLoader
from model import load_bundle_embedder
from realeval import GAL, ROWS, COLS
from evalreal import evaluate

def main():
    RUN = sys.argv[1]; EPOCHS = int(sys.argv[2]) if len(sys.argv) > 2 else 6; LR = float(sys.argv[3]) if len(sys.argv) > 3 else 2e-4
    SCALE, M, BATCH = 30.0, 0.15, 256
    os.makedirs(f"runs/{RUN}", exist_ok=True)
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    torch.manual_seed(0)

    meta = json.load(open("data/train_rows.json"))
    test_names = set(meta["test_names"])
    NAME, ID = COLS.index("name"), COLS.index("id")
    masked = np.array([r[NAME] in test_names for r in ROWS])
    is_val = lambda row: int(hashlib.md5(ROWS[row][ID].encode()).hexdigest(), 16) % 25 == 0

    files = sorted(glob.glob("data/crops/*.jpg"))
    items = [(f, int(os.path.basename(f).split("_")[0])) for f in files]
    train = [it for it in items if not is_val(it[1])]
    val = [it for it in items if is_val(it[1])][:2000]
    print(f"{len(train)} train crops, {len(val)} val crops, {masked.sum()} gallery rows masked (test cards)", flush=True)

    from crops_ds import Crops

    G = torch.from_numpy(GAL).to(dev)  # N x 128, unit vectors
    mask_bias = torch.zeros(len(GAL), device=dev); mask_bias[torch.from_numpy(masked)] = -1e4

    model = load_bundle_embedder().to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    dl = DataLoader(Crops(train, True), batch_size=BATCH, shuffle=True, num_workers=4, drop_last=True, persistent_workers=True)
    steps = EPOCHS * len(dl); warm = min(300, steps // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warm) * 0.5 * (1 + np.cos(np.pi * min(s, steps) / steps)))

    @torch.no_grad()
    def val_eval():
        model.eval(); right, top1 = [], []
        for x, row in DataLoader(Crops(val, False), batch_size=256, num_workers=2):
            e = model(x.to(dev)); s = e @ G.T + mask_bias
            r = s[torch.arange(len(row)), row.to(dev)]
            right.append(r.cpu()); top1.append((s.argmax(1).cpu() == row).float())
        right, top1 = torch.cat(right), torch.cat(top1)
        print(f"  sim-val: top1 (exact artwork) {top1.mean():.1%}  right median {right.median():.3f}", flush=True)
        model.train()

    print("before training:", flush=True); val_eval(); evaluate(model.cpu()); model.to(dev)
    step = 0; t0 = time.time()
    for ep in range(EPOCHS):
        model.train(); tot = 0.0; n = 0
        for x, row in dl:
            x, row = x.to(dev, non_blocking=True), row.to(dev)
            e = model(x)
            cos = e @ G.T
            logits = SCALE * (cos - M * F.one_hot(row, len(GAL))) + mask_bias
            loss = F.cross_entropy(logits, row)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step(); step += 1
            tot += loss.item(); n += 1
            if step % 100 == 0:
                print(f"ep {ep} step {step}/{steps} loss {tot / n:.3f} lr {sched.get_last_lr()[0]:.2e} {(time.time() - t0) / step:.2f}s/step", flush=True)
        torch.save(model.state_dict(), f"runs/{RUN}/ep{ep}.pt")
        print(f"epoch {ep} done, loss {tot / max(n, 1):.3f}", flush=True)
        val_eval(); model.cpu(); evaluate(model); model.to(dev)
    print("finished", flush=True)

if __name__ == "__main__":
    main()
