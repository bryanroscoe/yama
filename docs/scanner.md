# Card scanner spike

Status: OCR scanner in `web/src/scanner/`, available from Collection and the planner's swap sheet. Research measurements below are from 2026-10-18; the hybrid embedding stage remains a proposal.

Since 2026-10-25, Plans, Prints, Swap sheet (and each plan deck's Changes tab) can scan either side of a now-to-after-prints swap and immediately show the replacement, add and cut reasons, destination and installed status. This mode reads identity from the saved card names plus plan names, including both faces, without a printing lookup or network price request. It changes no data. The sheet also accepts a photo or an exact typed name. Live phone-camera accuracy still needs a real device check; the measurements below use synthetic captures.

Labels used below:

- **[ran]**: verified by running something on this machine (MacBook, Apple M3 Pro).
- **[read]**: read in docs or source, not executed.
- **[inferred]**: my conclusion, not checked.

## Summary

- **Recommendation: a hybrid.** Use an art-embedding lookup to say *which card* it is, and OCR of the bottom-left collector line to say *which printing*. Build it in two steps:
  1. **Now (built):** OCR only. The collector line (`R 0214` over `MOM • EN`) is looked up with the existing `GET /api/printings/lookup`. The title is read too: it confirms the lookup, and it is the fallback for cards that print no set code. About 6 MB of downloads, all Apache-2.0 or MIT, no third-party model. In simulated captures it gets **82% of cards right, with 0 confident wrong answers** [ran]. It is weak on 1993-2003 frames and on dark, blurred, glary shots.
  2. **Next:** add the MPL-2.0 ManaVault/oracle embedding bundle as the first stage. On the same simulated captures it got **96% top-1 on card identity in every condition, including the rough ones, in about 108 ms** [ran]. It does not tell reprints with the same art apart, and it misses sideways cards (battles). OCR covers both gaps.
- **Card position:** a fixed on-screen card guide, then a small edge finder (no OpenCV) that snaps the guide to the card's real edges. With the snap, corner error drops from 6.5% to 0.6% of the card width in handheld shots, and OCR accuracy rises from 78% to 82% overall [ran]. It can't find a black-bordered card on a black mat; the guide is used as is then.
- **CollectorVision stays out.** Its code and its model weights are both AGPL-3.0 (the Hugging Face model card says `license: agpl-3.0`) [read]. Its catalog is MIT, but the catalog is only useful with the AGPL model.
- **Not yet tested on a phone.** Everything ran in Node and desktop Chromium on synthetic captures made from Scryfall scans. See "Left for a real phone test".

## Options compared

| | A. Collector OCR + title OCR (built) | B. Embedding retrieval (ManaVault bundle) | C. Hybrid: B for identity, A for printing |
|---|---|---|---|
| Card right, simulated captures | 82% overall; 96% steady, 92% handheld, 88% far, 96% upside down, 38% rough [ran] | 96% in every condition when the card is upright (0% upside down unless retried at 180°) [ran] | about 96% card [inferred from both runs] |
| Exact printing | 100% steady and handheld, 73% overall, for cards that print a set code [ran] | Only to the artwork. Reprints that share art collapse to one entry; `printings.json` (126 MB) lists the siblings [read] | Embedding narrows to the art; the collector line or one tap picks the printing |
| Weak spots | 1993-2003 frames (33%), blur, glare and dark frames, black card on black mat | Sideways cards (battle: 0/10), cards newer than the bundle | Fewer |
| Confident and wrong | 0 of 130 at the 0.8 threshold [ran] | Right answers scored 0.80 to 0.99; wrong ones at most 0.76 [ran] | |
| Time per frame, laptop | median 328 ms, p90 576 ms (Node); 116 to 379 ms per photo in Chromium [ran] | 108 ms in WASM on one thread (Node) [ran] | about 110 ms when sure, plus OCR when the printing is needed |
| Time per frame, phone | 2 to 4 times the laptop [inferred] | same [inferred] | |
| Download (gzipped) | eng model 2.95 MB + one WASM core 2.9 MB (uncompressed) + worker script [ran] | embed.onnx 3.7 MB + search.onnx 12.3 MB + arts.json 4.0 MB + ORT WASM 3.7 MB = 23.7 MB [ran] | both, about 30 MB |
| Offline | Yes, once the OCR files are served by the app (now they come from jsDelivr) and the offline card bundle is on the device; printing lookup still calls the server | Yes, once cached | Yes |
| Licences | tesseract.js Apache-2.0, tesseract.js-core Apache-2.0, eng model MIT package of Apache-2.0 Tesseract data | MPL-2.0 code and weights; onnxruntime-web MIT | both |
| Effort | Done (prototype) | 1 to 2 days to port the glue (we write our own; their TS is MPL, ours stays private) [inferred] | 2 to 3 days after B [inferred] |
| New sets | Nothing to do (the card database already updates) | Wait for a new bundle, or run oracle's `new-set` ourselves (Python, about 3 GB of art crops) [read] | |

Not pursued:

- **CollectorVision** (AGPL code and weights).
- **OpenCV.js** for corner finding: about 8 to 10 MB for one feature [inferred from the usual build sizes]. The edge finder here is about 200 lines.
- **ManaVault's detector.onnx** (12.6 MB): the guide plus the edge finder did well enough. Worth trying with the hybrid if free-hand scanning (no guide) is wanted.
- **Native OCR** (iOS Vision, Android ML Kit, through a Capacitor plugin). It is likely faster and more accurate on small print [inferred], but it needs native code on two platforms. Keep `OcrEngine` as the seam for it.

## How the built pipeline works

```
frame ─▶ grey ─▶ guide quad ─▶ snap to the card's edges (locate.ts)
      ─▶ collector crop, upscaled ─▶ Tesseract (block, uppercase whitelist) ─▶ parse set, number, language
      ─▶ title crop, cropped to its text band ─▶ Tesseract (single line) ─▶ fuzzy match over ~37k names
      ─▶ decide: lookup(set, number); the title confirms it, or picks the printing from the set or number
```

- The crops are sampled straight from the camera frame through the card's homography, at 2400 px per card height for the collector line and 1200 for the title. Nothing is straightened at full size.
- The parser fixes OCR lookalikes (`M0M` to `MOM`), anchors the set code on the language code after it (`MOM • EN`), takes the number only from the line above, and ignores copyright years.
- Confidence: collector line plus a matching title is 0.97. A clear title plus the set code or the number is 0.8 to 0.9. The collector line alone is 0.85 only when the set code was read exactly and the number is zero-padded or has a total (`0214`, `030/280`); otherwise 0.5. A title alone is at most 0.9 and gives no printing. `ScannerView` locks on at 0.95, or when the same card comes back twice within 2.5 s at 0.6 or more.
- Upside-down cards: the live view alternates upright and 180° reads between frames. `scanFrame` retries at 180° itself when nothing sure was found (used for photos).

## Measured results [ran]

Setup: 26 real card scans from Scryfall's image CDN (`large`, 672 × 936), rendered into 1080 × 1440 "phone frames" near an on-screen guide (78% of the frame width; 50% for "far"). Card mix: 10 from 2023 or later, 5 from 2015-2022, 2 double-faced (a battle and a transform card), 3 full-art or showcase (a full-art Forest, borderless Sheoldred, a Mystical Archive), 3 from 2003-2014, 3 from 1993-2003 (one white-bordered). Five capture conditions, each card once per condition (130 scans):

- **steady**: 1° rotation, 0.5% skew, slight blur, JPEG 90, felt background.
- **handheld**: 3% offset from the guide, scale 0.94 to 1.03, 4° rotation, 2% skew, darker, side lighting, blur σ 1.2, noise, JPEG 75, wood.
- **rough**: 5% offset, 6° rotation, 3% skew, 65% brightness, a glare spot, blur σ 1.8, more noise, JPEG 60, black mat.
- **far (720p-like)**: the handheld settings with the card at half the frame width (about 540 × 750 px).
- **upside down**: handheld turned 180°.

"Quad" is where the pipeline thinks the card is: `refined` is the shipped default (guide snapped to the edges), `guide` is the guide alone, `truth` is the exact corners (an upper bound for OCR). "Printing right" counts only cards that print a set code.

### OCR pipeline (Tesseract.js 7, Node 26)

| Quad | Variant | Scans | Card right | Printing right | Confident and wrong | Median ms | p90 ms | Median corner error |
|---|---|---|---|---|---|---|---|---|
| refined | steady | 26 | 96% | 100% | 0 | 308 | 399 | 0.3% |
| refined | handheld | 26 | 92% | 100% | 0 | 316 | 429 | 0.6% |
| refined | rough | 26 | 38% | 15% | 0 | 512 | 671 | 9.1% |
| refined | far (720p-like) | 26 | 88% | 80% | 0 | 270 | 501 | 2.4% |
| refined | upside down | 26 | 96% | 70% | 0 | 522 | 633 | 4.7% |
| **refined** | **all** | 130 | **82%** | **73%** | **0** | 328 | 576 | 3.4% |
| guide | all | 130 | 78% | 63% | 1 | 274 | 563 | 6.7% |
| truth | all | 130 | 85% | 77% | 1 | 251 | 505 | 0.0% |

| Quad | Frame kind | Scans | Card right | Printing right | Via collector line |
|---|---|---|---|---|---|
| refined | 2023+ | 50 | 92% | 78% | 78% |
| refined | 2015-2022 | 25 | 84% | 60% | 60% |
| refined | double-faced | 10 | 90% | 80% | 90% |
| refined | full-art, showcase | 15 | 87% | 73% | 73% |
| refined | 2003-2014 | 15 | 87% | n/a | 13% |
| refined | 1993-2003 | 15 | 33% | n/a | 7% |

Corner error for the upside-down rows is inflated: when neither orientation was sure, the reported quad is the upright one. The name index (36,673 names and faces) builds in about 125 ms.

### Embedding retrieval (ManaVault bundle `scanner-bundle-retrain-20261015T173913849634Z`, onnxruntime-web 1.30 WASM, one thread)

Same 130 scenes (same seeds), embedding at the guide or the exact corners, top-k from `search.onnx`. "Card right" means the top art belongs to the card.

| Quad | Variant | Top-1 card | Top-5 card | Median ms |
|---|---|---|---|---|
| guide | steady, handheld, rough, far (each) | 96% | 96% | 108 |
| guide | upside down | 0% | 0% | 108 |
| truth | every variant (each) | 96% | 96% | 108 |

Every miss with an upright card is the battle (Invasion of Tolvada, printed sideways); its top match scored 0.52 to 0.55. Correct matches scored 0.80 to 0.99 (median 0.96), with a median lead of 0.36 over the second. Loading the two graphs and `arts.json` took about 350 ms.

### In the browser [ran]

`web/src/scanner/dev.html` on the Vite dev server in desktop Chromium, logged in with the dev account, real Rust server: the "Use a photo" path recognised War Historian (MOM 214) in 138 ms and Cremate (RTR 59, from its title plus "59/274") in 379 ms. Borderless Sheoldred came back as the right card but "Printing not read", since its number line was lost and DMU has several Sheoldred printings. The camera path could not be exercised (no camera in the automated browser).

### Why these numbers are optimistic [inferred]

- The scenes are Scryfall's flat, evenly lit scans. Real photos add sleeves, foil glare, focus breathing, motion blur and rolling-shutter skew.
- The embedding gallery was built from the same Scryfall art crops the scenes were made from, so retrieval is near-duplicate matching. ManaVault does train on synthetic phone scenes and real captures [read], which should help, but measure on real photos before trusting 96%.
- Phone CPUs are slower than an M3 Pro, and a web view without cross-origin isolation gets one WASM thread.

## Licences of what this uses or proposes

| Thing | Licence | Used how |
|---|---|---|
| tesseract.js 7.0.0 | Apache-2.0 [read: npm] | dependency of `web` |
| tesseract.js-core 7.0.0 (WASM) | Apache-2.0 [read: npm] | loaded by tesseract.js |
| `@tesseract.js-data/eng` 4.0.0_best_int | MIT package [read: npm]; the data is Tesseract's `tessdata_best`, Apache-2.0 [read] | downloaded at runtime (2.95 MB) |
| jpeg-js 0.4.4 | BSD-3-Clause [read: npm] | dev dependency, eval harness only |
| onnxruntime-web 1.30.0 | MIT [read: npm] | eval only, downloaded to /tmp; not a dependency |
| cfbender/oracle code and `models/*.pt` | MPL-2.0 [read: repo licence] | not used directly |
| ManaVault scanner bundle (ONNX weights, gallery) | MPL-2.0 (published as releases of `cfbender/manavault`, an MPL-2.0 repo; the bundle has no separate licence file) [read] | eval only, downloaded to /tmp |
| Oracle's recogniser starting point | torchvision MobileNetV3-Small `IMAGENET1K_V1` weights, fine-tuned on Scryfall art crops and the author's captures [read: `cardid/model.py`, CONTRIBUTING] | |
| CollectorVision code and `milo` model | AGPL-3.0 [read: GitHub, Hugging Face model card] | not used |
| Scryfall images | Wizards' copyright, served under Scryfall's guidelines | 26 test images in /tmp, never committed |

MPL-2.0 is file-level copyleft: if we ship the bundle files inside the app (TestFlight counts as distribution), those files' source must stay available, which it already is upstream. Our own code can stay private [inferred, not legal advice]. The ImageNet starting weights and the Scryfall training images are the usual grey areas of hobby vision models; for a private, free, invite-only app this seems fine, but it is a judgment call for Bryan [inferred].

## The prototype

```ts
import { ScannerView } from "./scanner";
<ScannerView onAccept={(card) => addToCollection(card)} onClose={() => navigate(-1)} />
```

`card` is a `ScanCandidate`: `{ name, set?, number?, lang?, scryfall_id?, image?, confidence, method }`. `method` is `"collector+name"`, `"collector"` or `"name"`; a `"name"` result has no printing and should open a printing picker.

For other uses, the pipeline is pure:

```ts
const res = await scanFrame(imageData, { ocr, catalog, names, guide });
// res.candidates (best first), res.quad, res.raw (OCR text), res.timings
```

`OcrEngine` and `ScanCatalog` are injected: `createTesseractOcr()` and `createServerCatalog()` for the app, `eval/dbCatalog.ts` (read-only SQLite) for tests.

Files, all under `web/src/scanner/`:

| File | What |
|---|---|
| `index.ts` | public exports |
| `types.ts` | `RgbaImage`, `Quad`, `OcrEngine`, `ScanCatalog`, `ScanCandidate`, `ScanResult` |
| `pipeline.ts` | `scanFrame`, `decide`, crop regions, confidence rules |
| `locate.ts` | `refineQuad`: guide to card edges |
| `image.ts` | homography, warp, Otsu, text-band crop, BMP encoder |
| `parse.ts` | collector-line parser, set-code lookalikes, name normalising |
| `fuzzy.ts` | trigram plus fitting-edit-distance name index |
| `pick.ts` | `pickPrinting`: printing from title plus partial collector read |
| `tesseract.ts` | `OcrEngine` on tesseract.js (two workers) |
| `serverCatalog.ts` | `ScanCatalog` on the server API and the offline card bundle |
| `ScannerView.tsx`, `scanner.css` | camera screen |
| `dev.html`, `dev.tsx` | stand-alone page: `http://localhost:5173/src/scanner/dev.html` |
| `scanner.test.ts` | unit tests, part of `npm test` |
| `eval/` | accuracy harness: fixtures, scene simulator, DB catalog, `eval.test.ts`, `embedding.test.ts` |

Run the evals (need `data/yama.db`; they download card images and models into `/tmp/yama-scanner-spike` on first run):

```sh
SCANNER_EVAL=1 npx vitest run web/src/scanner/eval/eval.test.ts            # OCR, default quad only, about 1.5 min
SCANNER_EVAL=1 SCANNER_EVAL_QUADS=refined,guide,truth npx vitest run web/src/scanner/eval/eval.test.ts  # all three, about 4 min
SCANNER_EMBED_EVAL=1 npx vitest run web/src/scanner/eval/embedding.test.ts # embeddings, 50 MB download, about 90 s
```

## Left for a real phone test

1. **HTTPS.** Phones only open the camera on https or localhost. Run Vite with a dev certificate (for example `@vitejs/plugin-basic-ssl`, MIT) and open it on the LAN, or test in the Capacitor shell. Until then, "Use a photo instead" works over plain http.
2. **Self-host the OCR files** so it works offline: copy `tesseract.js/dist/worker.min.js`, one `tesseract.js-core` WASM build and `eng.traineddata.gz` into `web/public/` and pass `workerPath`, `corePath` and `langPath` to `createTesseractOcr`.
3. **A real eval set.** Photograph the October purchases (`commander-decks/data/purchases.json` gives set and number for each) in sleeves, under room light, foils included, and rerun both evals on them. Replace the 0.8/0.95 thresholds with ones measured there.
4. **Speed on Bryan's iPhone**, per frame and for the first load (workers and model). If OCR is over about 500 ms, try one worker with the title read only when needed, or the native OCR route.
5. **Server:** add `GET /api/sets` (codes only). Without it `createServerCatalog` treats any 2 to 5 character code as plausible, which costs extra 404 lookups and weakens lookalike correction.
6. **Then the hybrid:** port the embed and search glue (our own code), cache the bundle in IndexedDB, map `arts.json` entries to our printings by set and number, and keep OCR for the printing and for battles.

## Sources

- tesseract.js <https://github.com/naptha/tesseract.js>; language data <https://github.com/naptha/tessdata>
- cfbender/oracle <https://github.com/cfbender/oracle> (README, `docs/pipeline.md`, `cardid/model.py`, CONTRIBUTING); ManaVault <https://github.com/cfbender/manavault> (releases, `assets/react/src/pages/scan/recognition/pipeline.ts`, read only)
- CollectorVision <https://github.com/HanClinto/CollectorVision>; model card <https://huggingface.co/HanClinto/milo>; catalog <https://github.com/HanClinto/CollectorVisionCatalog>
- onnxruntime-web <https://www.npmjs.com/package/onnxruntime-web>
- Scryfall image guidelines <https://scryfall.com/docs/api/images>
