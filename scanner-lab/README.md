# Scanner lab: Yama's query embedder

These scripts made `yama-art-20261118.onnx`, the model phones run in place of the ManaVault bundle's
`embed.onnx` to match a card's art (docs/scanner.md, "Yama's query embedder"). They are here so the
model can be made again, checked, or trained further. Nothing in CI runs them except
`test_scanner_lab.py`, which needs no packages.

- **What the model is:** the bundle's `embed.onnx` with its embedding half (MobileNetV3-Small, a
  576 → 128 head) fine-tuned on simulated sleeved, glare and blue-box phone captures, against the
  bundle's frozen gallery vectors. The front half (the warp and the 17 frame cuts) is the bundle's
  graph, byte for byte. So `search.onnx`, `arts.json` and the server's art supplement don't change.
- **Licence:** the model is derived from ManaVault's MPL-2.0 weights
  (<https://github.com/cfbender/manavault>), so the model file is MPL-2.0. These scripts are part of
  Yama ([LICENSE](../LICENSE)).
- **Where it is:** the release `scanner-art-20261118` of this repository. `server/src/scan.rs`
  (`QUERY_MODEL`) pins its URL, size and SHA-256.

## Layout

Run every script from a work directory **outside the repository**: `python <lab>/train.py …`, where
`<lab>` is this folder. They read and write there:

| Path | What | Size (Nov 2026) |
|---|---|---|
| `bundle/` | the pinned ManaVault bundle (or `SCANNER_BUNDLE_DIR`) | 39 MB |
| `models/` | `front.onnx` and `back.onnx` (`split.py`), exported models | 10 MB each |
| `data/train_rows.json` | the gallery rows picked for training (`pick_train.py`) | 0.2 MB |
| `data/cards/` | Scryfall `normal` images of those cards (`download.py`) | 2.5 GB |
| `data/crops/` | simulated captures cut to 128 × 128 crops (`gen.py`) | 0.5 GB |
| `data/real_crops.npz` | the real photos' crops, cached by `evalreal.py` (people's data) | 200 MB |
| `runs/<run>/epN.pt` | a checkpoint per epoch (`train.py`) | 4 MB each |
| `out/` | `realeval.py`'s per-photo scores | small |

Card images are Scryfall's, fetched for training and never published: delete `data/cards/` and
`data/crops/` when you're done.

## Inputs

- **The bundle.** A server that has opened the scanner keeps it in `data/scan-bundle/<version>/`
  (`manifest.json`, `embed.onnx`, `search.onnx`, `arts.slim.json`); copy that folder to `bundle/`.
  ManaVault's release page has the same files (`arts.json` there; the server's `slim_arts` makes the
  slim one). The model fits only bundles whose `manifest.json` names the recogniser checkpoint
  `retrain-20261026T052522727512Z` (`recogniser.sha256` `eb655846…`): a bundle from a newer
  checkpoint needs the model trained again from its own `embed.onnx`.
- **Real scan photos** (`SCANNER_REAL_DIR`, default `data/own`): `<id>.jpg` and `manifest.jsonl`,
  as `yama-server scan-samples-export DIR --owner <your user id>` writes them on a server where you
  scanned with "Save scan photos" on (docs/scanner.md, "Scan photos"). Use your own: they are
  people's photos, and stay out of the repository and anything public. Every card name in them is
  held out of training, so they are a fair test.
- **A copy of Yama's database** (`YAMA_DB`): to look up each photo's artwork. Opened read-only and
  immutable. Your own server's `data/yama.db`, copied while it's stopped, does; it holds people's
  data too, so keep it outside the repository and delete it when done.

## Making the model again

```sh
python3.12 -m venv .venv && .venv/bin/pip install -r <lab>/requirements.txt
export SCANNER_REAL_DIR=… YAMA_DB=…          # see Inputs
.venv/bin/python <lab>/split.py              # models/front.onnx, models/back.onnx from bundle/embed.onnx
.venv/bin/python <lab>/pick_train.py         # data/train_rows.json: 24,000 rows in common frames, test names held out
.venv/bin/python <lab>/download.py &         # data/cards/: ~8 requests a second, about 50 minutes
sh <lab>/gen_loop.sh                         # data/crops/: 2 captures per card (K=2) while the download runs
.venv/bin/python <lab>/train.py art1 8 2e-4  # runs/art1/ep0..7.pt, with the held-out and real-photo scores per epoch
.venv/bin/python <lab>/sweep.py runs/art1    # the lock-rule safety table for the bundle's model and each epoch
.venv/bin/python <lab>/export.py runs/art1/ep6.pt models/yama-art-YYYYMMDD.onnx
```

- `sim.py` renders the captures (`render(card, rng, level)`; roughness drawn from U(0.2, 2.0) by
  `gen.py`): sleeves (75%, matte with a mesh or stipple sparkle and haze, or glossy blobs, with a
  coloured edge), foil sheen, a blue box with cards behind, a table, a mat, paper or a hand, colour
  casts, exposure, defocus, motion blur, noise, sharpening, JPEG and the browser's downscale to a
  640 px short side; the quad is the card's corners with the detector's error, or the sleeve's edge.
- `train.py`: CosFace (scale 30, margin 0.15) of each crop's embedding against all 52,350 gallery
  vectors, with the 990 rows of the real photos' card names masked; AdamW, lr 2e-4, weight decay
  1e-4, batch 256, cosine schedule after a 300-step warm-up, light brightness and contrast jitter and
  a random occluding patch. Cards whose id's md5 % 25 is 0 (1,874 crops) are held out. About six
  minutes on an M3 Pro's GPU (MPS).
- **Pick the checkpoint by the sweep**, not the loss: the lead rule (top ≥ 0.65 and ≥ 0.10 ahead of
  any other card) should lock more real photos with none wrong, and lock fewer unknown cards (the
  right card's name hidden from the gallery). Epochs 4, 6 and 7 were close; 6 shipped.
- `calib.py LEVEL N [SLEEVE_P]` scores held-out simulated captures at one roughness (`EMBED=` another
  model); `realeval.py DATA_DIR` scores the bundle's model on the real photos with preprocessing
  variants.
- Then: publish the file as a release asset (not marked latest: the Android app's updater reads the
  `android-app` release by its tag), pin all five fields of `QUERY_MODEL` in `server/src/scan.rs`,
  and run the recognizer eval with `SCANNER_EMBED` (docs/scanner.md).

**Checked 18 Nov 2026** (these copies of the scripts, the versions in `requirements.txt`, the
training run's own data and checkpoints, which aren't published): `split.py` gives the
`front.onnx` and `back.onnx` the run used, byte for byte; `export.py runs/art1/ep6.pt` gives
`yama-art-20261118.onnx` byte for byte (sha256 `52420d90…`); and `sweep.py runs/art1 bundle ep6.pt`
prints the same table as the run did for both. Training itself wasn't run again.
