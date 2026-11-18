"""Training crops as a torch Dataset."""
import numpy as np, torch, cv2
from torch.utils.data import Dataset

MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)

class Crops(Dataset):
    def __init__(self, items, aug): self.items, self.aug = items, aug
    def __len__(self): return len(self.items)
    def __getitem__(self, k):
        f, row = self.items[k]
        img = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
        if self.aug:
            rng = np.random.default_rng()
            img = np.clip((img - 0.5) * rng.uniform(0.85, 1.15) + 0.5 + rng.uniform(-0.06, 0.06), 0, 1)
            if rng.random() < 0.3:  # a finger, a glare patch or a sleeve fold over part of the art
                h, w = img.shape[:2]; eh, ew = int(h * rng.uniform(0.1, 0.35)), int(w * rng.uniform(0.1, 0.35))
                y, x = rng.integers(0, h - eh), rng.integers(0, w - ew)
                img[y:y + eh, x:x + ew] = rng.uniform(0, 1, 3) if rng.random() < 0.5 else 1.0
        img = (img - MEAN) / STD
        return torch.from_numpy(img.transpose(2, 0, 1).copy()), row

