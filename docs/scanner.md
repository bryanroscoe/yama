# Card scanner

Status (2026-10-28): the hybrid is built. The scanner in `web/src/scanner/` recognises the card by its **art** (ManaVault's MPL-2.0 detector and embedding models, our own glue, in a web worker), finds the card anywhere in the frame, and settles the **printing** from the printings that share that art: the only one, or the collector line read by OCR, or the person's pick. A scan never files a guessed printing. The OCR-only scanner remains as the fallback for cards the art index doesn't know (new sets, battles) and for when the recognition bundle isn't available. See "The art recognizer (built 2026-10-28)". The research below, from 2026-10-18, is kept as written.

Why it changed (Bryan, 2026-10-28): scanning is now how the collection is kept, and the OCR scanner was slow, needed the card lined up exactly, misread cards, and filed two cards under the wrong printing. That last one was a bug: a title-only read was added as Scryfall's default printing (`Collection.tsx`). It's gone; a scan without a settled printing can't be added.

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

## The art recognizer (built 2026-10-28)

```
camera frame, short side 640 ─▶ worker: detector on the middle 640 px square (then the whole frame if nothing)
      ─▶ detector again on a window where the card fills 60% ─▶ card quad, top first, any rotation
      ─▶ embed (the graph warps the card itself) ─▶ search: top 5 of 51,843 illustrations
      ─▶ lock at score ≥ 0.82, or ≥ 0.62 on two agreeing frames
      ─▶ GET /api/scan/printings?art=<illustration id>: the printings that share the art
      ─▶ one English printing: done. Several: OCR the collector line (full-resolution crop at the quad)
         and pick among them (pickPrinting). Still unsure: the person picks from thumbnails.
art score < 0.5 for 3 frames ─▶ the OCR pipeline below, at the detector's quad (a quarter turn per try, for battles)
```

- **Bundle:** `scanner-bundle-retrain-20261026T052522727512Z` from `cfbender/manavault` releases, pinned with SHA-256 sums in `server/src/scan.rs`. The server downloads it once into `data/scan-bundle/<version>/` (on startup when imports run, or on the first `GET /api/scan/bundle`), drops the 126 MB `printings.json` it doesn't need, and turns the 18 MB `arts.json` into a 6 MB column form (3.2 MB gzipped). It serves the files at `/scan-bundle/<version>/` as immutable. Phones never fetch from GitHub.
- **On the phone:** the first scanner open downloads about 39 MB over the wire (detector 12.6 MB, search 13.9 MB, embed 5.1 MB, artwork index 3.2 MB, ONNX Runtime WASM 3.9 MB, gzipped where it helps), with a progress line, into the Cache API (`yama-scan-v1`, kept by `sw.js`). Later opens load from the cache. Tesseract is loaded only when a collector line has to be read.
- **Printings that share art:** `printings.illustration_id` and `back_illustration_id` (migration 0034, filled by the `default_cards` import, importer version 3, so a running server re-imports on its next pass). Until a printing has illustration data, the endpoint returns every printing of the card (`same_art: false`); the collector line then has to read the set code exactly to settle it.
- **Cards the index doesn't know:** a bundle from 26 October doesn't know cards printed after it, and the bundle leaves out battles and art series. These score below 0.6 (wrong matches scored at most 0.58 in the eval), so the scanner reads their text instead. Move to a newer bundle by changing the tag and sums in `scan.rs` and rerunning the recognizer eval. ManaVault publishes a bundle every week or two.
- **Re-arming:** after Add (or Not this), the same artwork isn't found again until the card leaves the view or another card shows, so one card is never added twice by accident. Copies (1 to 10) are chosen on the result.
- **Typing instead:** "Or type the name" opens the same printing picker.
- **Close-up step (Bryan's idea, 2026-10-28):** a whole card in view gives the collector line only about 1 to 2% of the frame's height, so when the first read can't settle the printing, step 2 starts by itself: a wide box replaces the card guide and asks for the phone close to the bottom-left corner. Each frame, just that box is read at full camera resolution (scaled to 200 px tall) and matched against the printings that share the art. A read of both set code and number settles it at once; set code or number alone needs the same answer twice. The picker stays below, so tapping is always an option. For cards whose art isn't known, after two failed text reads (or with "Read the name up close") the scanner asks for the title the same way, then goes on to the printing.
- **Camera resolution:** the scanner asks for 3840 × 2160 (browsers give the nearest they have) and continuous focus where the browser exposes it. The resolution actually delivered is shown under "What the scanner saw". Frames are scaled to 640 px for recognition; only text crops use the full resolution.

### Measured [ran]

Node 26, onnxruntime-web 1.31.1 WASM on one thread, M3 Pro. The 26 eval cards rendered into 1080 × 1440 phone frames with **no guide to line up with**, scaled to a 640 px short side as the app does (`eval/recognizer.test.ts`):

| Variant | Scans | Card found | Right card | Wrong with score ≥ 0.8 | Median corner error | Median ms |
|---|---|---|---|---|---|---|
| off-centre (anywhere, 75 to 115% size, ±12°) | 26 | 100% | 96% | 0 | 2.5% | 161 |
| tilted 20-35° | 26 | 100% | 96% | 0 | 2.8% | 162 |
| sideways (90°) | 26 | 100% | 100% | 0 | 5.8% | 162 |
| upside down | 26 | 100% | 96% | 0 | 6.4% | 161 |
| small (a third of the frame width) | 26 | 96% | 92% | 0 | 4.3% | 161 |
| rough (dark, glare, blur, black mat) | 26 | 96% | 92% | 0 | 5.2% | 161 |
| steady, in the old guide | 26 | 96% | 96% | 0 | 1.6% | 161 |
| far, in the old guide | 26 | 100% | 96% | 0 | 1.9% | 160 |
| **all** | 208 | **99%** | **96%** | **0** | 3.1% | 161 |

Right answers scored 0.76 to 0.99 (median 0.97); wrong ones at most 0.58. Every miss is the battle (not in the index; it goes to OCR) or the full-art Forest when small or under glare. The OCR scanner got 82% on easier scenes that were lined up with the guide.

Close-ups (`eval/closeup.test.ts`): the collector line and title cut from each eval card's 672 × 936 scan, turned up to 3°, noisy, read the way the close-up box is read, choosing among **all** of the card's printings in the database (harder than among one artwork's): printings **19 of 26 right, 0 wrong**, 7 left to the picker (the five pre-2015 frames print no set code; EOE 224's number was misread and its set code alone left two printings). Titles: 20 of 26 names. Real close-ups have several times these source pixels.

In desktop Chromium against the local server ("Use a photo", synthetic photos): an off-centre WOC Arcane Signet was recognised in 199 ms; 32 printings share its art, and the collector line ("WOC • EN", number misread as 0149) picked WOC #145. An upside-down ECC Sol Ring was the only printing with its art. The STA Counterspell and the borderless DMU Sheoldred #290 (which the OCR scanner couldn't place) were settled by the collector line. The off-centre battle fell back to OCR and was read by name with a quarter-turned quad, leaving two printings to pick from.

## How the OCR pipeline works

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
| onnxruntime-web 1.31.1 | MIT [read: npm] | dependency of `web`; its WASM runtime is a build asset |
| cfbender/oracle code and `models/*.pt` | MPL-2.0 [read: repo licence] | not used directly |
| ManaVault scanner bundle (ONNX weights, gallery) | MPL-2.0 (published as releases of `cfbender/manavault`, an MPL-2.0 repo; the bundle has no separate licence file) [read] | downloaded by the server, served unmodified to the app (the artwork index reduced to fewer fields); source: <https://github.com/cfbender/manavault/releases> and <https://github.com/cfbender/oracle> |
| Oracle's recogniser starting point | torchvision MobileNetV3-Small `IMAGENET1K_V1` weights, fine-tuned on Scryfall art crops and the author's captures [read: `cardid/model.py`, CONTRIBUTING] | |
| CollectorVision code and `milo` model | AGPL-3.0 [read: GitHub, Hugging Face model card] | not used |
| Scryfall images | Wizards' copyright, served under Scryfall's guidelines | 26 test images in /tmp, never committed |

MPL-2.0 is file-level copyleft: when we serve the bundle files to browsers, those files' source must stay available, which it is upstream (linked above). Our glue (`recognizer.ts`, `art.worker.ts`) is our own, written from the graphs' inputs and outputs, so it stays private [inferred, not legal advice]. The ImageNet starting weights and the Scryfall training images are the usual grey areas of hobby vision models; for a private, free, invite-only app this seems fine, but it is a judgment call for Bryan [inferred].

## Using it

```ts
import { ScannerView } from "./scanner";
<ScannerView onAccept={(card, copies) => addToCollection(card, copies)} onClose={() => navigate(-1)} />
```

`card` is a `ScanCandidate`: `{ name, set?, number?, lang?, scryfall_id?, image?, confidence, method }`. `method` is `"art"`, `"collector+name"`, `"collector"` or `"name"`. Unless `identityOnly` is set, `onAccept` is only offered once the printing is settled, so `scryfall_id` is always there.

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
| `recognizer.ts` | the art recognizer: detector, embed and search graphs (ONNX Runtime passed in) |
| `art.worker.ts`, `artClient.ts` | the recognizer in a web worker; bundle download and Cache API |
| `printings.ts` | `printingOptions` (`/api/scan/printings`) and `choosePrinting` |
| `printings.test.ts` | unit tests for the printing choice and the recognizer's pure parts |
| `serverCatalog.ts` | `ScanCatalog` on the server API and the offline card bundle |
| `ScannerView.tsx`, `scanner.css` | camera screen |
| `dev.html`, `dev.tsx` | stand-alone page: `http://localhost:5173/src/scanner/dev.html` |
| `scanner.test.ts` | unit tests, part of `npm test` |
| `eval/` | accuracy harness: fixtures, scene simulator, DB catalog, `eval.test.ts` (OCR), `recognizer.test.ts` (art, free-hand), `embedding.test.ts` (the 2026-10-18 spike) |

Run the evals (need `data/yama.db`; they download card images and models into `/tmp/yama-scanner-spike` on first run):

```sh
SCANNER_EVAL=1 npx vitest run web/src/scanner/eval/eval.test.ts            # OCR, default quad only, about 1.5 min
SCANNER_EVAL=1 SCANNER_EVAL_QUADS=refined,guide,truth npx vitest run web/src/scanner/eval/eval.test.ts  # all three, about 4 min
SCANNER_EMBED_EVAL=1 npx vitest run web/src/scanner/eval/embedding.test.ts # embeddings, 50 MB download, about 90 s
SCANNER_EVAL=1 npx vitest run web/src/scanner/eval/closeup.test.ts  # close-up step, about 30 s
SCANNER_RECOGNIZER_EVAL=1 SCANNER_BUNDLE_DIR=data/scan-bundle/<version> npx vitest run web/src/scanner/eval/recognizer.test.ts  # art, free-hand, about 2 min
```

## Left for a real phone test

1. **Live camera on Bryan's phone.** Everything above is synthetic photos and desktop Chromium; the camera loop (lock thresholds 0.82 once or 0.62 twice, re-arming between cards) hasn't run on a phone. Check frame time (the target was 250 ms), the first-open download, sleeves and foil glare.
2. **A real eval set.** Photograph real cards (the October purchases give set and number for each), sleeved, under room light, foils included, and rerun `recognizer.test.ts` and `eval.test.ts` on them. Retune the thresholds there.
3. **Collector-line reads on real cards.** Commander precon reprints share art (32 English Arcane Signets), so the printing often rests on reading the set code, from the whole card or the close-up. Note the camera resolution the phone reports. If reads still fail often, the next step is a native app (below).
4. **Newer bundles.** Cards printed after the pinned bundle go to OCR. Bump the bundle when a set Bryan buys is out.
5. **Native app, if the web isn't enough (Bryan can publish to the App Store, 2026-10-28).** The Capacitor shell is already a dependency. A native scanner plugin would get the full-resolution camera with proper focus and zoom, and on-device text recognition far better on small print than Tesseract (Apple Vision on iOS, ML Kit on Android) behind the existing `OcrEngine` seam; the art recognizer can stay as it is. Decide after the phone test.

## Sources

- tesseract.js <https://github.com/naptha/tesseract.js>; language data <https://github.com/naptha/tessdata>
- cfbender/oracle <https://github.com/cfbender/oracle> (README, `docs/pipeline.md`, `cardid/model.py`, CONTRIBUTING); ManaVault <https://github.com/cfbender/manavault> (releases, `assets/react/src/pages/scan/recognition/pipeline.ts`, read only)
- CollectorVision <https://github.com/HanClinto/CollectorVision>; model card <https://huggingface.co/HanClinto/milo>; catalog <https://github.com/HanClinto/CollectorVisionCatalog>
- onnxruntime-web <https://www.npmjs.com/package/onnxruntime-web>
- Scryfall image guidelines <https://scryfall.com/docs/api/images>
