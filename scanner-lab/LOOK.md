# Scanner lab: the printing look model

These scripts made the set-symbol half of `yama-look-v1.onnx`, the model that compares the card in the
camera's frame with each printing that shares its artwork (docs/scanner.md, "The printing look"). Run them
like the rest of the lab, from a work directory outside the repository (README.md, "Layout").

- **What the model is:** one ONNX graph with the art model's interface. Inputs `scene` (height × width × 4,
  uint8 RGBA) and `quad` (4 × 2, the card's corners, top-left first, clockwise, in scene pixels). Outputs
  `symbol` and `card` (1 × 128, L2-normalised).
  - The graph warps the card itself: the set symbol's area (card y 0.525–0.605, x 0.76–0.975) to
    160 × 80, and the whole card to 320 × 448.
  - It standardises each channel of each image to mean 0, sd 1, then runs two MobileNetV3-Small networks
    with GeM pooling and a 128-number head.
  - A candidate printing's Scryfall `normal` image goes in with its own corners as the quad.
  - Score = 0.8 × symbol·symbol + 0.2 × card·card.
- **Licence:** Yama's ([LICENSE](../LICENSE)). The networks start from torchvision's ImageNet
  MobileNetV3-Small weights (BSD-3-Clause). Card images are Scryfall's: fetched for training, never
  published.
- **Where it is:** release `scanner-look-20261120` of this repository; `server/src/scan.rs` pins it in the
  model registry (`MODELS`).

## Layout (on top of README.md's)

| Path | What | Size (Nov 2026) |
|---|---|---|
| `data/look_groups.json` | every artwork several English paper printings share (`look_groups.py`): train, and test (the real photos' artworks) | 16 MB |
| `data/printings/` | Scryfall `normal` images of those printings (`look_download.py`) | 7 GB |
| `data/pk2/`, `data/pq2/` | the graph's own symbol crops: clean keys, and 2 simulated captures per printing (`look_gen.py`) | 0.8 GB, 1.1 GB |
| `runs/<run>/epN.pt` | a checkpoint per epoch (`look_train.py`) | 4 MB each |

Delete `data/printings/`, `data/pk2/` and `data/pq2/` when you're done.

## Making the symbol network again

```sh
export SCANNER_REAL_DIR=…                      # your real scan photos (README.md, "Inputs")
.venv/bin/python <lab>/look_groups.py          # data/look_groups.json, from Scryfall's bulk card data
.venv/bin/python <lab>/look_download.py        # data/printings/, eight images a second, about two hours
.venv/bin/python <lab>/look_gen.py             # data/pk2/ and data/pq2/, two to three hours on 5 cores
.venv/bin/python <lab>/look_train.py sym3 8 64 # runs/sym3/ep0..7.pt, scored on the real photos each epoch
.venv/bin/python <lab>/look_export.py runs/sym3/ep7.pt <card checkpoint> models/yama-look-vN.onnx
.venv/bin/python <lab>/look_eval.py models/yama-look-vN.onnx
```

- `look_crops.py` cuts exactly what the exported graph cuts, in OpenCV (a cosine of 0.9999 to the graph's
  own output). The symbol patch has a margin, so training can shift it: the centre crop is the graph's.
  Training on the graph's crops matters. v0's symbol network was trained on a different cut, and the
  exported graph scored 57.1% where the training code scored 62.2%.
- `look_train.py`: InfoNCE of one simulated capture per artwork against the clean symbols of up to six of
  its printings, across a batch of 64 artworks (temperature 0.05). A MoCo key encoder (momentum 0.99)
  embeds the clean side. Its BatchNorm statistics must follow the query network's as well as its weights.
  Without that (the first run) the loss climbs after an epoch and the real-photo score falls from 60% to
  53%. Photometric haze, gamma and colour casts on both sides; AdamW at 3e-4 with one cycle. About seven
  minutes for 8 epochs on an M3 Pro's GPU.
- **The card half** (weight 0.2) is v0's. The lab's first script made it from whole-card 320 × 448
  captures of 6,000 artworks picked from a database copy, so it can't be made again here exactly.
  Retraining it with this method over every printing is the next step.

**Checked 20 Nov 2026:**
- `look_export.py runs/sym3/ep7.pt <v0's card checkpoint>` gives `yama-look-v1.onnx` byte for byte
  (sha256 `152f52c1…`).
- `look_eval.py` gives the figures below.
- `look_train.py` ran a smoke test (MAXSTEPS=30). It is the script that trained `sym3`, with the paths
  changed; the training wasn't run again in full.
- `look_groups.py` rebuilt from Scryfall's bulk data on 20 Nov has the same 23,996 training artworks and
  the same 92 test artworks; 3 of the test artworks differ by a printing from the database copy the run
  used.

## Measured (20 Nov 2026)

On one tester's 98 real sleeved phone photos (640 px frames, the phone's own quads) of artworks several
printings share, with those artworks and card names held out of training:

| Model | Right printing first | Right, or a strict visual twin |
|---|---|---|
| Today's list order (newest first) | 40.8% | |
| `yama-look-v0` | 57.1% | 74.5% |
| CollectorVision (run privately, never in Yama) | 75.5% | 84.7% |
| **`yama-look-v1`** | **86.7%** | **95.9%** |

- A strict visual twin (`look_crops.strict_twin`) is a printing with the same picture and the same
  set-symbol area, so only the collector number separates them. 30 of the 98 photos have one.
- v1 runs in 8 ms per image on this Mac's CPU. A simulated held-out set of 492 artworks scores 79.5%.
- `look_eval.py`'s margin table: v1's top printing leads every other by 0.10 or more on 45 photos, none
  wrong. Of the rest, 27 were narrowed to strict twins, all of them including the right one, and 26 left
  to the collector line.
