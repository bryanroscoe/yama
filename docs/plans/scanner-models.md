# Scanner models of our own, sleeves, and a fallback on the server

Status: in progress, 18 Nov 2026.
- **Shipped:** locking on the art's lead (PR #166).
- **Shipped:** our own art model (PR #167, `yama-art-20261118`).
- **Not good enough yet:** the printing model.
- **Waiting:** two decisions for Bryan, at the end.

Asked for by Bryan, 18 Nov 2026: "I'm talking about training our own somehow… I think we should
experiment with all of them… We need to really be able to simulate the different weirdnesses that we
see in some of these pictures, which are glares and stuff, because I want to be able to scan cards that
are sleeved not just ones that aren't sleeved." He also wants an optional fallback that sends a card to
the server in stages, and said the scanner "gets stuck… 50% of the time".

Experiments, scripts and data live outside the repository in `~/Developer/.agent-tasks/scanner-model-lab/`
(the photos are people's own and never enter the repository). The training code for the shipped model
goes into the repository with it. This page records what was measured and what comes next.

## What real scans look like (measured)

The test set is one tester's 125 saved scan photos (`scan_samples`, mid-November 2026, Pixel 10 Pro at
2160 × 3840), used with their consent. 124 have a known artwork; 120 have a known printing.

- **They're sleeved.** Close up, the art shows a textured matte sleeve: a fine diamond mesh or stipple, a
  glint on every bump, and a white haze that washes out contrast. Most were shot down in a blue deck box:
  a blue cast, dim light, the cards behind showing above the card.
- **The art model knew the card but wasn't sure of it.** The bundle's model, re-run offline with the same
  graphs, gives the same scores the phone logged. It puts the right card first on 96%, but at a median
  score of **0.78** (p10 0.65); on the repository's synthetic eval it's 0.97. The best wrong card's median
  is 0.58. Only **36%** reached the 0.82 that locked at once. Below that, the scanner read the title every
  frame and waited up to four frames: the stall.
- **The stuck scans aren't recorded.** A scan photo is saved only when a card is added, corrected or marked
  wrong, and Scanner diagnostics (which keep the struggles) were off. These are all scans that worked.
- **Most need the printing.** 98 of the 120 are of artwork that several English printings share (median 4
  each). The art can't choose among them, so the collector line has to be read.

## Results

These are offline measurements on one saved photo per card. "Qualify" means that photo's art scores meet the
rule. The live camera settles on a lead only when the same card leads on two frames in a row (`LEAD_FRAMES`
in `fuse.ts`); a still photo settles on one. So the live gain is "settled after two art-only frames, with no
title read" for most cards, not "on the first frame". It hasn't been timed on a phone; Scanner diagnostics
now record which rule settled each card, which will measure it.

| Experiment | Result on the real photos | Verdict |
|---|---|---|
| Lock on the art's lead: top ≥ 0.65 and ≥ 0.10 ahead of the next different card | One photo's scores qualify for 84.7% (36% reached 0.82), 0 wrong; 0 of 124 unknown cards | Shipped, PR #166 |
| White balance, contrast stretch, blur, anti-aliasing before the model | Within ±0.01 of the median | Rejected |
| Averaging the embedding over shifted or scaled quads | +0.005 | Rejected |
| **Our art model**: the bundle's embedder fine-tuned on simulated sleeved captures (see below) | One photo's scores qualify for the lead rule on 94.4%, 0 wrong; right card 96.8% | Shipped, PR #167 |
| CollectorVision (AGPL; run privately, never in Yama) | Card 95%. Among the art's siblings: exact printing 75.5%, right printing or a visual twin 90.8% | The bar for a printing model |
| **Our printing model**, whole card (320 × 448, MobileNetV3 Small, 4 epochs) | Exact 38.8%, right or twin 59.2% (chance 24.7%). On simulated captures of the same cards: 50.8% exact | Not good enough |
| **Our printing model**, set-symbol area only (the type line's right end, 160 × 80) | Untrained already 48.0% / 69.4%; trained (5 epochs) 60.2% / 79.6% | The right idea |
| Set symbol and whole card combined (0.8 / 0.2) | Exact 62.2%, right or twin 81.6% | Best so far; CollectorVision is 75.5% / 90.8% |

### The lead rule needs our art model

On 1,840 held-out simulated captures, each cut into every frame as the phone does
(`scanner-lab/fullsweep.py`), the lead rule with the bundle's model locks 10 cards wrongly and locks 28
unknown cards (cards hidden from the gallery) as something else. With our model it locks 0 wrongly and 9
unknown. So shipping our model also made PR #166 safer. (A first sweep that scored one crop per card had 8
→ 0 and 25 → 6; Codex's review of #167 caught it.) Unknown cards are rare in practice: the server
adds new sets' art within hours, and the gallery leaves out battles and art series.

## The simulator

`sim.py` renders a Scryfall card image as a phone capture:
- **Sleeves (75%):** a coloured sleeve edge, and either a textured matte surface (mesh or stipple sparkle,
  haze following a glare field) or a glossy one (soft specular blobs).
- **The card:** foil sheen (25%).
- **Where it was shot:** a blue box with cards behind, a table, a mat, paper or a hand.
- **Light:** a light field, blue or warm casts, exposure and gamma.
- **The phone:** defocus, motion blur, noise, phone sharpening, JPEG, and the browser's downscale to the
  recognizer's 640 px.
- **The detector's quad:** with its error, or the sleeve's edge.

At roughness 1.5 the bundle's model scores simulated sleeved cards at a median of 0.80, against the real
photos' 0.78.

## Our art model (shipped 18 Nov 2026, PR #167)

- **What changes:** the query side of the art match only. The bundle's embedder (MobileNetV3 Small, 128
  numbers) is fine-tuned against the bundle's frozen gallery vectors (CosFace over all 52,350 artworks). The
  gallery, the search graph, the art index and the server's art supplement stay as they are. Phones get a
  different `embed.onnx` (same inputs and outputs, same size and speed). It applies only to galleries from
  the same recogniser checkpoint.
- **Training:** 24,000 Scryfall card images, 49,240 simulated captures cut by the bundle's own warp graph,
  8 epochs, about 6 minutes on this Mac's GPU. The real-photo cards were held out.
- **Measured:**
  - 124 real photos: one photo's scores qualify for the lead rule on 84.7% → 94.4%, 0 wrong, 0 unknown
    locked; p10 score 0.654 → 0.688.
  - Held-out simulated sleeved, hard: right card 83.8% → 95.8%.
  - Bare cards: right 99.5% → 100%, locks at 0.82 94.8% → 97.2%.
  - The details, the training code (`scanner-lab/`) and the switch (`YAMA_SCAN_QUERY_MODEL`) are in
    docs/scanner.md. The file is a release asset (`scanner-art-20261118`), MPL-2.0 like the weights it
    comes from.
- **Not measured:** a live phone check, and the art supplement's own eval with the new model.
- **A newer bundle needs a retrain.** ManaVault has published `retrain-20261117…`. Moving the pin to it
  turns our model off (it only runs on galleries from the checkpoint it was trained against) until
  `scanner-lab/` retrains it against the new gallery.

## The printing model (next)

Telling apart printings that share one artwork is the bigger prize: it's what the collector-line read does
today, slowly and often not at all from a whole-card view. What the first attempt showed:
- **A whole card at 320 × 448 is too coarse.** The set symbol, which tells most same-art printings apart
  (Commander precon reprints, reprint sets), is about 13 to 20 pixels wide there. The network learned
  overall tone first, matching a hazy sleeved card to a pale old-frame printing. Normalising each image's
  colour and stronger haze helped (right or twin 59.2% after 4 epochs), but it reached only 50.8% exact
  even on simulated captures.
- **The set symbol's area is where the signal is.** A network looking only at the type line's right end
  scores 69.4% right or twin on the real photos before any training, and 79.6% after five epochs.
  Combined with the whole-card model it reaches 81.6%, against CollectorVision's 90.8%. Its real-photo input is a
  640 px card (a symbol of about 20 pixels); live scans have the 4K frame, where it's 40 or more.
- **Some siblings are the same picture.** Some groups hold printings whose scans differ only in the collector
  number or a small stamp: FIN 45 and FIN 580, PIP 209 and PIP 737 (surge-foil numbering), FIN 128 and its
  prerelease-stamped 128s. No image model separates those from a scan; only the number does, so the score
  counts "right or a visual twin" separately.
- **Training on the Mac's GPU** needs fixed input shapes (it recompiles for every new shape) and a small
  footprint: the machine was swapping at 11 of 12 GB.

Next attempt, in order:
1. Train the set-symbol model at full resolution: Scryfall's `large` scans on the clean side, captures
   rendered at 4K scale, and all 76,588 printings that share art instead of 19,475. On the phone it would
   cut the symbol from the full-resolution frame (as the collector-line read does now).
2. Visual twins go to the collector line (4K strip, ML Kit in the app); the picker remains the last step.
3. Measure on real 4K captures (Scanner diagnostics keep the full-resolution strip; a symbol crop would
   need the same) before shipping anything. The 98 photos here are 640 px and one person's, so
   differences under about 5 points are noise.

## Stages, and a fallback on the server (proposed)

1. Phone: the art model with the lead lock. Most cards stop here.
2. Phone: when the art is shared, the printing model chooses among the siblings (once it's good enough).
3. Phone: the collector line and title OCR, as now, when 2 isn't sure.
4. Server, optional: the card photo goes to the server, which runs bigger versions of the same models (a
   larger query network can map into the same gallery) and server-size OCR. It's for a card the phone
   can't settle, not every frame (the round trip is too slow for that). Off unless the person turns it on,
   because the photo leaves the phone.

## Decisions for Bryan

- **CollectorVision's free noncommercial licence.** CollectorVision is AGPL, which Yama's licence can't take:
  the scanner's code and model are downloaded to people's phones, which is distribution, so all of Yama
  would have to be AGPL. It also offers a free licence for noncommercial projects on request (name, email,
  intended use). That would let Yama use its whole-card printing model now (90.8% right or twin among the
  siblings on the test photos, against our 81.6%) while ours catches up. It needs Bryan's name and email, so it's his to send.
- **The server fallback** sends a card photo to Yama's server when it's on. Off by default, as he said.
