# Scanner lab: Yama's query embedder

These scripts made `yama-art-20261118.onnx`, the model phones run in place of the ManaVault bundle's
`embed.onnx` to match a card's art (docs/scanner.md, "Yama's query embedder"). They are here so the
model can be made again, checked, or trained further. Nothing in CI runs them except
`test_scanner_lab.py`, which needs no packages. The printing look model's scripts (`look_*.py`) are
described in [LOOK.md](LOOK.md).

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
| `speed/frames/` | the speed bench's frames, made from Scryfall images (`speed_frames.py`) | 100 MB |

Card images are Scryfall's, fetched for training and never published: delete `data/cards/`,
`data/crops/` and `speed/frames/` when you're done.

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
PYTHON=.venv/bin/python sh <lab>/gen_loop.sh # download.py into data/cards/ (~8 requests a second, about 50
                                             # minutes) and gen.py's crops into data/crops/ (K=2) alongside
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
  right card's name hidden from the gallery). Epochs 4, 6 and 7 were close; 6 shipped. `sweep.py`'s
  simulated half scores one crop per card (its own frame's cut) against every row, which is quick
  but leaves out wrong matches through other frames' cuts; its real-photo half uses all 17 cuts.
  Check the exported file with `fullsweep.py bundle/embed.onnx models/<name>.onnx`, which renders
  the held-out captures again and scores them as the phone does (several minutes on 6 cores).
- `calib.py LEVEL N [SLEEVE_P]` scores held-out simulated captures at one roughness (`EMBED=` another
  model); `realeval.py DATA_DIR` scores the bundle's model on the real photos with preprocessing
  variants.
- Then: publish the file as a release asset (not marked latest: the Android app's updater reads the
  `android-app` release by its tag), pin it in `server/src/scan.rs` (`MODELS`: an option with its URL, size and SHA-256 and the recogniser it was trained against),
  and run the recognizer eval with `SCANNER_EMBED` (docs/scanner.md).

**Checked 18 Nov 2026** (these copies of the scripts, the versions in `requirements.txt`, the
training run's own data and checkpoints, which aren't published): `split.py` gives the
`front.onnx` and `back.onnx` the run used, byte for byte; `export.py runs/art1/ep6.pt` gives
`yama-art-20261118.onnx` byte for byte (sha256 `52420d90…`); and `sweep.py runs/art1 bundle ep6.pt`
prints the same table as the run did for both. Training itself wasn't run again. `fullsweep.py` on
the bundle's `embed.onnx` and the exported file gave the whole-capture table in docs/scanner.md.

## Speed

`speed/drive.mjs` times the scanner's art recognizer in Chrome: it bundles `web/src/scanner/recognizer.ts`,
serves a bench page cross-origin isolated (so WASM may use threads), runs every frame through
`createRecognizer` as the art worker does, and prints each graph's median time per configuration
(docs/scanner.md, "Speed"). It needs the repository's `npm ci` (playwright-core, rolldown, onnxruntime-web)
(`rolldown` comes with Vite) and an installed Google Chrome. From the bundle it reads `detector.onnx`, `search.onnx`,
`arts.slim.json` and `manifest.json`; `--embed` is the art model to time.

```sh
.venv/bin/python <lab>/speed_frames.py 40    # speed/frames/: 160 frames of 40 held-out cards (needs data/cards/)
node <repo>/scanner-lab/speed/drive.mjs --bundle bundle --embed models/yama-art-20261118.onnx \
  --frames speed/frames --out out/speed.json \
  "ep=wasm&threads=1" "ep=wasm&threads=4" "build=ort.webgpu.min.mjs&ep=webgpu" "build=ort.jspi.min.mjs&ep=webgpu"
```

A configuration is the page's query: `build` (an `onnxruntime-web/dist` bundle, default `ort.all.min.mjs`),
`ep` (`wasm` or `webgpu`), `threads`, `detector=wasm` (or `embed=`, `search=`) to keep one graph on WASM,
`embedFile=/bundle/embed.onnx` for the bundle's own embedder, `n` to run fewer frames. `HEADED=1` shows the
browser. The frames are made from Scryfall images, so like `data/cards/` they stay out of the repository.

## Two cuts first (`yama-art-20261118-cascade.onnx`)

`cascade.py` adds an int64 `cuts` input to an art model: only the named frame cuts go through the
network, and the output keeps all 17 rows (zeros for the rest). `recognizer.ts` embeds the modern and old
cuts first and the others only when those don't settle the frame (docs/scanner.md, "Faster options").
`cuts` is a required input (onnxruntime-web won't take a feed for an initializer), so only an app that
knows it loads this file. `cascade.py models/yama-art-20261118.onnx models/yama-art-20261118-cascade.onnx`
gives the published file byte for byte (sha256 `103b3d9a…`); with all 17 cuts fed it gives the original's
output exactly.

## Yama's card finder (`yama-corners-20261120.onnx`)

A corner detector with the bundle detector's input and outputs, one view a window (docs/scanner.md,
"Faster options"). From the work directory, with `data/cards/` (README "Layout"):

```sh
for i in 0 1 2 3 4 5; do                       # general windows, 2 a render (labels every 250 renders; the
                                               # shipped model's run was stopped at 20,172 from ~10,500)
  .venv/bin/python <lab>/corners_gen.py data/corners/train $((i*4000)) 4000 $((100+i)) & done; wait
SPLIT=val .venv/bin/python <lab>/corners_gen.py data/corners/val 0 1000 999      # held-out cards
for i in 0 1 2 3; do                           # tight photos of the card, windowed as the scanner does
  MODE=photo .venv/bin/python <lab>/corners_gen.py data/corners/train_photo $((100000+i*1000)) 1000 $((300+i)) & done; wait
.venv/bin/python <lab>/corners_train.py c1 18 2e-3                                  # runs/c1/epN.pt
ROOTS=train,train_photo .venv/bin/python <lab>/corners_train.py c2 8 1e-3 runs/c1/ep8.pt
.venv/bin/python <lab>/corners_export.py runs/c2/ep5.pt models/yama-corners-20261120.onnx
EMBED=models/yama-art-20261118.onnx .venv/bin/python <lab>/corners_eval.py bundle models/yama-corners-20261120.onnx
```

- `corners_gen.py` renders with `sim.py` (its `room` range and the true corners in `meta["card_quad"]`; the
  defaults draw what the art model was trained on, byte for byte) and cuts the recognizer's 256 px windows:
  coarse ones with the card at 28 to 98% of the side, fine ones near 60%, any rotation, 0 to 2 fingers or a
  thumb (skin tones, shading, a nail), a second card half in view (10%), empty windows (8%). Labels are the
  card's corners as printed, top-left first, covered or not.
- `corners_train.py`: MobileNetV3-Small from torchvision's ImageNet weights, a small FPN to a 64 × 64 grid,
  per corner a softmax over the cells of (cell centre + offset), so a covered corner is voted for by the
  edges around it; a presence head on the pooled features. Loss: L1 on the corners (over the window) +
  0.2 × cross-entropy to a Gaussian at each corner + 0.3 × presence. AdamW, batch 96, random quarter turns.
  The first run (18 epochs) stopped after epoch 9 (`ep8.pt`, 2.0% median corner error on held-out windows);
  the second fine-tuned it with the tight photos; its `ep5.pt` shipped (1.4%). About 50 minutes in all on an
  M3 Pro's GPU. **Don't edit it while it trains**: macOS DataLoader workers import it afresh.
- `corners_eval.py` runs `identify()`'s coarse and fine passes (ported) with each detector, then the art
  model and the lead rule, on the held-out windows, simulated frames with and without fingers, and the real
  photos. `corners_export.py runs/c2/ep5.pt` gives the published file byte for byte (sha256 `18f9d6aa…`).
- Inputs and outputs: `window` uint8 256 × 256 × 4 → `quad` 4 × 2, `up` 2 (`[0, -4p]`, so the recognizer's
  vote is the presence probability p), `centre` 2, `short` (the bundle's formula). Its licence: Yama's own
  model; torchvision's code is BSD-3-Clause, and the ImageNet starting weights and Scryfall training images
  are the usual grey areas (docs/scanner.md, "Licences").

## The printing look's parity check

`look_parity.py MODEL OUT.json` runs a printing look model (`yama-look-v0.onnx`, docs/scanner.md,
"The printing look") on two synthetic scenes in Python's onnxruntime and writes the outputs the
repository's parity test compares with (`web/src/scanner/eval/look-parity.json`; checked 20 Nov
2026: it remakes that file byte for byte with onnxruntime 1.32). The look model's training scripts
and the real-photo replay's inputs stay in the lab for now: the replay's are people's data.
