"""Pick training artworks from the gallery: common frames, excluding the real-photo test cards."""
import json, os, random, sys
import numpy as np
from paths import BUNDLE, REAL
from realeval import ROWS, COLS, FRAMES, labels
frame_names = json.load(open(f"{BUNDLE}/manifest.json"))["constants"]["frame_names"]
ID, NAME, ILL, LAYOUT = (COLS.index(c) for c in ("id", "name", "illustration_id", "layout"))
test_names = {ROWS[i][NAME] for r, ill in labels(REAL) for i in range(len(ROWS)) if ROWS[i][ILL] == ill}
os.makedirs("data", exist_ok=True)
keep = {"modern", "old", "extended", "tall", "token", "token_tall"}
cand = [i for i, r in enumerate(ROWS) if frame_names[FRAMES[i]] in keep and r[NAME] not in test_names]
random.seed(7); random.shuffle(cand)
pick = sorted(cand[:24000])
json.dump({"rows": pick, "test_names": sorted(test_names)}, open("data/train_rows.json", "w"))
from collections import Counter
print(len(cand), "candidates;", len(pick), "picked;", len(test_names), "test card names held out")
print(Counter(frame_names[FRAMES[i]] for i in pick))
