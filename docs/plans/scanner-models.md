# Scanner models of our own, sleeves, and a fallback on the server

Status: in progress, updated 21 Nov 2026.
- **Shipped, 18 Nov:** locking on the art's lead (PR #166), and our own art model (PR #167,
  `yama-art-20261118`).
- **Shipped, 20 Nov:**
  - switching models per device in Scan settings, with a server switch to withdraw a model (PR #170);
  - the printing look ordering the printing list (PR #172);
  - under Scanner diagnostics, a timing record for every card settled (PR #171);
  - full-resolution set-symbol and collector-strip crops with each scan photo (PR #171);
  - the look model v1 as the look's default, which puts the right printing first on 86.7% of the test
    photos (PR #175);
  - two faster models to choose, after CardVision: Yama's card finder, and the art model with two cuts
    first (PRs #169 and #174). A frame on one WASM thread takes 39 ms with both, against 125 ms;
  - the look settling the sure printings, as an opt-in option (`look-v1-sure`; "Next", item 1).
- **Shipped, 21 Nov:** the one-tap speed test (PR #182) and server-prepared printing vectors (PR #185).
  The faster finder and art model took 53 ms while tracking and 68 ms while searching on a Pixel 11 Pro,
  against 214 ms and 213 ms with the defaults. The test used downloaded card images and one WASM CPU
  thread. The WebView reported a hardware WebGPU adapter. The default and faster model choices still
  need a live, same-camera comparison.
- **Waiting:** CollectorVision's licence, asked 20 Nov (now optional), and the server fallback; see
  "Decisions for Bryan".

Asked for by Bryan, 18 Nov 2026: "I'm talking about training our own somehow… I think we should
experiment with all of them… We need to really be able to simulate the different weirdnesses that we
see in some of these pictures, which are glares and stuff, because I want to be able to scan cards that
are sleeved not just ones that aren't sleeved." He also wants an optional fallback that sends a card to
the server in stages, and said the scanner "gets stuck… 50% of the time". On 20 Nov: "We can get more. I
think we should… get all of these merged and move it along as much as you can", "We should have the
ability to switch scanners on the fly… switch between models when things break", and, of
https://app.mtgscan.org/: "want to be able to do as well as this guy. He is really fast."

Experiments, scripts and data live in a work directory outside the repository (`scanner-lab/README.md`,
"Layout"); the photos are people's own and never enter the repository. The training code for each shipped model
goes into the repository with it: `scanner-lab/` (README.md for the art model, LOOK.md for the look
model). This page records what was measured and what comes next.

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
  each). The art can't choose among them; their look or the collector line has to.
- **The photos are 640 px.** The set symbol is about 20 px across in them, the collector line about 7 px.
  Live scans have the full-resolution frame.

## Results

These are offline measurements on one saved photo per card. "Qualify" means that photo's art scores meet the
rule. The live camera settles on a lead only when the same card leads on two frames in a row (`LEAD_FRAMES`
in `fuse.ts`); a still photo settles on one. So the live gain is "settled after two art-only frames, with no
title read" for most cards, not "on the first frame". It hasn't been timed on a phone. Scanner diagnostics
keep only scans that struggle (over 3 s to find, or corrected), with the rule that settled each. They show
what still stalls but can't measure the overall gain. Since 20 Nov 2026 they also keep a timing record for
every card settled (`get_scan_timings`, PR #171), so it can be measured once someone scans with the switch
on.

| Experiment | Result on the real photos | Verdict |
|---|---|---|
| Lock on the art's lead: top ≥ 0.65 and ≥ 0.10 ahead of the next different card | One photo's scores qualify for 84.7% (36% reached 0.82), 0 wrong; 0 of 124 unknown cards | Shipped, PR #166 |
| White balance, contrast stretch, blur, anti-aliasing before the model | Within ±0.01 of the median | Rejected |
| Averaging the embedding over shifted or scaled quads | +0.005 | Rejected |
| **Our art model**: the bundle's embedder fine-tuned on simulated sleeved captures (see below) | One photo's scores qualify for the lead rule on 94.4%, 0 wrong; right card 96.8% | Shipped, PR #167 |
| ManaVault's newer bundle, `retrain-20261117…` (new recogniser and detector), its own model | Right card 94.4% (the pinned bundle's model: 96.0%); lead rule 81.5%; 1 unknown card locked | Not better: stay on `gallery-20261106` |
| Printing look v0: the first symbol and whole-card networks, exported as one graph | Right printing first 57.1% (the list's newest-first order: 40.8%; chance 24.7%) | Shipped, ordering the list (PR #172) |
| CollectorVision (AGPL; run privately, never in Yama) | Card 95%. Among the art's printings: exact 75.5%, right or a strict visual twin 84.7% | The bar we set ourselves |
| **Printing look v1**: the symbol network trained on the graph's own crops over all 78,063 shared-art printings | **Exact 86.7%, right or a strict visual twin 95.9%** | The look's default since 20 Nov (PR #175) |
| v1 and CollectorVision combined | Exact at best 86.7%; at each one's best margin, picks alone on more photos with none wrong (59 against v1's 45) | Optional now |

**A correction (20 Nov).** The 18 Nov figures for "right or a visual twin" (59.2%, 79.6%, 81.6%, and
CollectorVision's 90.8%) counted a printing as a twin whenever its whole clean scan matched in grey
(correlation over 0.97). That also counts printings that differ only in their set symbol, which is exactly
what a printing model should tell apart: 54 of the 98 photos had such a "twin". The strict rule
(`scanner-lab/look_crops.py`, `strict_twin`) also needs the set-symbol area to correlate (over 0.95). Then
30 of the 98 have one. It's a benchmark category, not a proof: such printings look alike, so mostly only
the collector number tells them apart. Every figure above uses the strict rule.

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
  - The details, the training code (`scanner-lab/`) and the switch (Scan settings, "Models"; the server's
    `YAMA_SCAN_WITHDRAW`) are in docs/scanner.md. The file is a release asset (`scanner-art-20261118`),
    MPL-2.0 like the weights it comes from.
- **Not measured:** a live phone check, and the art supplement's own eval with the new model.
- **A newer ManaVault bundle needs no retrain for now.** `retrain-20261117…` (new recogniser and detector)
  is worse on the real photos than the pinned bundle's model (above). Moving the pin to it would also turn
  our model off: it only runs on galleries from the checkpoint it was trained against.

## The printing look (shipped 20 Nov 2026: PR #172 with v0, then v1 as the default, PR #175)

Telling apart printings that share one artwork is the bigger prize: it's what the collector-line read does
today, slowly and often not at all.
- **How it works:** one ONNX graph with the art model's interface takes the camera frame and the card's quad,
  and each candidate printing's Scryfall `normal` image with its corners. It cuts the set symbol's area
  (the type line's right end) and the whole card itself, and compares them. The phone fetches the candidates'
  pictures at runtime and embeds them there, so no printing gallery is kept on the server.
  `scanner-lab/LOOK.md` has the details and the scripts.
- **What made v1 work:**
  - The set symbol's area carries the signal. A whole card at 320 × 448 learned overall tone instead,
    matching a hazy sleeved card to a pale old-frame printing.
  - Train on the crop the exported graph makes, geometrically aligned with it. v0 lost 5 points between
    the training code and the exported file.
  - All 78,063 printings that share art, not 19,475.
  - A training bug fixed: the MoCo key encoder's BatchNorm statistics never followed the network's.
- **What it does in the app now:** orders the printing list, the most alike first, and marks its best
  guess. It never files a printing by itself.
- **Measured (v1):** above. When v1's top printing leads the next one by 0.10 or more (twins included:
  the rule an app can run), it would have picked 45 of the 98 photos alone, none wrong; at 0.08, 54 with
  one wrong. Of the other 53, 27 were narrowed to strict twins (all of them including the right one) and
  26 left to the collector line. One photo shows a back face, which the lab compares with fronts.

Next, in order:
1. **Settle when sure, as an option. Built 20 Nov 2026** as `look-v1-sure`, "Yama's look model v1,
   settles when sure" (docs/scanner.md, "Settling by look"): once every printing in the list is scored
   and the closest leads the next by 0.10 or more, it settles that printing, shown and filed like a
   collector-line settle with Wrong printing, never against a collector-line read pointing to another
   printing. On these photos no pick with a strict twin led by that much. Not the default: 0 wrong of
   45 on 98 photos still allows about one in 15 wrong. **Still to do:** measure it on real scans. The
   timing records keep, under any look option, each look's lead (`look_lead`), what the rule said
   (`look_sure`) and whether its closest printing was filed (`look_top_filed`), and mark look settles
   and their corrections;
   `get_scan_timings`' `looks` compares the default and the option. Make it the default once those
   support it.
2. **The look as evidence for the collector line.** A look leader that the collector line half-read
   settles sooner. Visual twins go to the collector line, and the picker remains the last step.
3. **Full resolution.** The 98 photos are 640 px and one person's, so differences under about 5 points are
   noise. Since 20 Nov 2026 (PR #171) each kept scan photo has its set symbol's area and collector strip at
   full resolution (`scan-samples-export` writes them beside the photos), and Scanner diagnostics keep the
   same `symbol` crop beside `strip`. Train and measure on those.
4. **The card half** (weight 0.2) is v0's: retrain it the way the symbol half was.

## Matching CardVision (app.mtgscan.org)

CardVision is a free, closed-source native iPhone app by Florian Drechsler; its Android test starts 1
December. From its own pages (20 Nov 2026):
- a YOLO pose detector finds the corners, and places one a finger covers;
- a ResNet-50 embedder trained with ArcFace matches about 61,000 artworks stored on the phone;
- the set symbol and the collector number choose among about 100,000 printings;
- it runs on Core ML on the iPhone.

Its code and models aren't available to us; we copy the approach with our own training.

**Where Yama's time went** (Chrome on an M3 Pro, one WASM thread, 160 simulated sleeved frames; PR #169
added the bench, `scanner-lab/speed/`):
- The bundle's card finder runs four rotated copies of every window: 50 ms a pass.
- The art embedder runs the network on 17 frame-style crops: 62 ms.
- A tracked frame took 122 ms, a fresh one 174 ms.
- Native ONNX Runtime is no faster: it's the models' work, not WASM.
- CardVision does one card-finder pass and one art crop per frame, on the iPhone's Neural Engine.

**Shipped as options (PR #174, not the defaults):**
- **"Yama's card finder, 20 Nov":** MobileNetV3, trained on simulated captures with fingers over corners.
  12 ms a pass. Median corner error 1.4% against 4.0% (with fingers 1.7% against 6.7%). On the real photos
  it locks 92.7% against 94.4%, a difference of two photos, within noise; that's why it isn't the default.
- **"Yama's art model, 18 Nov, two cuts first":** embeds the two commonest frame styles first, and the
  other 15 only when they don't settle. 15 ms; the same answers as all 17 crops on the held-out captures
  and the real photos.
- **Both together:** a tracked frame takes 39 ms, a fresh one 51 ms, with the same top answer on every
  bench frame.

**Not done yet:**
- WebGPU is measured on desktop (about 35 ms a frame) but has yet to run the scanner on Android.
  The Pixel's WebView reported a hardware adapter in the speed test. Shipping the WebGPU build adds
  4.4 MB to every Android web update.
- Native ONNX Runtime in the Android app, and a bigger ArcFace art model with our own gallery, aren't built.
- The speed test measured model latency on the Pixel. Use Scanner diagnostics' timing records (PR #171)
  to compare live scans with the defaults and the faster options before switching the defaults.

**The printing look's pictures, from the server (21 Nov 2026).** The look spent most of its time
fetching each printing's Scryfall picture (about half a second each on a cold connection) and embedding
it on the phone. The server now embeds them ahead of time with the same model and the same JPEG decoder
as the phone's browser, and the phone asks for them first (docs/scanner.md, "Vectors from the server").

**The Pixel 10's TPU: not pursued for now (researched 21 Nov 2026).**
- An outside app can reach the Pixel 10's TPU only through Google's Tensor SDK, a beta of LiteRT.
- Getting it takes a sign-up form (name, company, job role, work email). Models have to be compiled
  ahead of time with a compiler plugin Google sends by email.
- Its documents deliver models only through Google Play (Play for On-device AI, Feature Delivery).
  Yama's Android app is sideloaded from GitHub.
- Its terms are proprietary. They forbid passing the SDK on unless Google allows it, and they forbid
  publishing any performance data about Google Tensor (sections 4.16 and 4.17). So Yama's public
  documents must never carry TPU timings.
- It works only on Pixel 10-family phones.
- NNAPI is deprecated since Android 15, and nothing says whether it still reaches the Pixel 10's TPU.
- On the Mac (docs/scanner.md, "Speed"), once the faster options are on, four threads or WebGPU only take
  a frame from 38.5 ms to 30 to 33 ms. For models this small the chip isn't where the time goes. It would
  matter for a much bigger model.
- **Decision:** not pursued for now. Revisit if Yama moves to a larger model; the phone's GPU through
  LiteRT is the open route.

## Stages, and a fallback on the server (proposed)

1. Phone: the art model with the lead lock. Identity-only scans (deck checks, box scans) mostly stop
   here. In the collection only cards whose art has one printing do: 22 of the 120 test photos. The
   other 98 need stage 2 or 3 for the printing.
2. Phone: when the art is shared, the printing look orders the candidates and, as an opt-in option
   since 20 Nov 2026, settles the sure ones.
3. Phone: the collector line and title OCR, as now, when 2 isn't sure.
4. Server, optional: the card photo goes to the server, which runs bigger versions of the same models (a
   larger query network can map into the same gallery) and server-size OCR. It's for a card the phone
   can't settle, not every frame (the round trip is too slow for that). Off unless the person turns it on,
   because the photo leaves the phone.

## Decisions for Bryan

- **CollectorVision's free noncommercial licence: asked 20 Nov**, with Bryan's go-ahead ("I'm not for
  profit… You have my permission to do whatever you want"), in
  https://github.com/HanClinto/CollectorVision/issues/63. CollectorVision is AGPL, which Yama's licence can't
  take: the scanner's code and model are downloaded to people's phones, which is distribution. The free
  licence for noncommercial projects would allow it, with a "Card recognition powered by CollectorVision"
  credit. v1 now beats it on the test photos, so it's optional. Combined with v1 it would let the look pick
  a printing alone on a few more photos.
- **The server fallback** sends a card photo to Yama's server when it's on. Off by default, as he said.
  Not built: the phone's own models now settle most cards, so it waits for evidence of what still fails.
