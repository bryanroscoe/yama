# The scanner's models, and where they live

Bryan, 25 Nov 2026: "Where are we saving this model that we're creating here? I have no idea what
kind of model we're creating at all. It's just kind of happening on the side." This page answers
that in one place. The detail of each (how it was measured, what was tried) is in
[scanner.md](scanner.md) and the lab's own notes ([scanner-lab/README.md](../scanner-lab/README.md),
[scanner-lab/LOOK.md](../scanner-lab/LOOK.md)).

## What runs when a card is scanned

The camera's picture goes through four steps. Three are small neural networks Yama trained itself,
each a few megabytes, running on the phone (in the app's own code on Android, or in the web page).
The fourth, reading text, is someone else's.

| Step | Default model | What kind of model | Trained on | Since |
|---|---|---|---|---|
| **Find the card**: its four corners in the picture, even with a finger over one or other cards under it | `yama-corners-20261124` | MobileNetV3-Small (an image network made for phones) with a small head that votes where each corner is, on a 256 px window. 4 MB. | Pictures Yama makes itself: Scryfall card images pasted onto tables, tilted, lit, sleeved, with fingers, and since 24 Nov tossed onto piles of other cards. Tens of thousands of such windows. Started from ImageNet weights. | 24 Nov 2026 (20 Nov version before it) |
| **Name the card by its art**: turn the art into 128 numbers and find the nearest artwork | `yama-art-20261118-cascade` | MobileNetV3-Small embedding network. 5 MB. The "cascade" is the same weights, trying the two commonest frame styles first. | Fine-tuned from ManaVault's open model (MPL-2.0) on simulated phone captures: sleeves, glare, blue deck boxes. The artworks it compares against are ManaVault's gallery of every card's art, plus the art of newer cards, which Yama's server adds itself after each card import. | 18 Nov 2026 |
| **Tell printings apart** that share one artwork: compare the card with each printing's picture | `yama-look-v1` | Two small embedding networks: one for the set symbol's area, one for the whole card. 9 MB. | Scryfall pictures of the 78,000 printings that share art with another, through simulated captures. | 20 Nov 2026 |
| **Read the text**: the title, and the set code and number in the bottom corner | ML Kit (Google's, in the Android app); PaddleOCR or Tesseract in a browser | Not Yama's; nothing trained here. | | |

Each step has options in Scan settings, Models (the earlier versions, ManaVault's own), and the
server can withdraw a broken one for everyone (`YAMA_SCAN_WITHDRAW`).

## Where the files are

- **The models phones run** are files attached to GitHub releases of this repository, which is
  public: [`scanner-models-20261124`](https://github.com/bryanroscoe/yama/releases/tag/scanner-models-20261124)
  (the card finder), [`scanner-models-20261120`](https://github.com/bryanroscoe/yama/releases/tag/scanner-models-20261120)
  (the 20 Nov finder, the art cascade), [`scanner-art-20261118`](https://github.com/bryanroscoe/yama/releases/tag/scanner-art-20261118)
  (the art model) and [`scanner-look-20261120`](https://github.com/bryanroscoe/yama/releases/tag/scanner-look-20261120)
  (the look models). Each release's notes say what the model is and how it measured.
- **What picks them**: `MODELS` in [server/src/scan.rs](../server/src/scan.rs) pins each file's
  address, size and SHA-256, and which is each step's default. After a deploy the server downloads
  any it doesn't have into its data folder on saget (`data/scan-bundle/<bundle>/`) and checks the
  hash; phones download them from Yama's server and keep them.
- **The code that trains them** is in [scanner-lab/](../scanner-lab/) in this repository:
  `corners_*.py` and `pile.py` for the card finder, `train.py` and the rest for the art model,
  `look_*.py` for the look.
- **Checkpoints to train further from** (PyTorch `.pt` files): the card finder's and the look's are
  in their releases beside the model (`yama-corners-20261124.pt`, added 25 Nov 2026;
  `yama-look-v1-card.pt`, `yama-look-v1-symbol.pt`). The art model's is only in the lab folder below.
- **The training data and scratch** are only on Bryan's Mac, in
  `~/Developer/.agent-tasks/scanner-model-lab/` (about 14 GB): Scryfall card images, the made-up
  training pictures, checkpoints of every run, and copies of scan photos shared from his own account
  for testing (people's data: never committed or published). Its `MANIFEST.md` lists every folder,
  why it's kept and when to review it. All of it but the scan photos can be made again with the
  lab's scripts; the scan photos stay on the server.

## Making a model the default

A new model is published as a release asset first, then a pull request pins it in `MODELS` as an
option or the default, with its measurements in [scanner.md](scanner.md) and a decision in
[ARCHITECTURE.md](../ARCHITECTURE.md). Merging deploys it like any change: the server downloads the
file, and phones switch to it the next time the scanner opens. Until the server has the file, the
model before it stands in (`STANDS_IN`).
