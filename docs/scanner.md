# Card scanner

Status (2026-11-13): inside the Android app the scanner reads text with **ML Kit** (`mlkit.ts`, `TextReaderPlugin.java`; picked by `ocrEngine.ts`); in browsers it reads with PaddleOCR's PP-OCRv5 models (ONNX Runtime, in a worker), with Tesseract as the fallback (see "Browser OCR: PP-OCRv5"). On the Android 16 emulator ML Kit read the collector line of five Scryfall scans (MOM 214, WOC 145, ECC 57, DMU 107, CMM 1) and each parsed to the right set and number, in 7 to 66 ms per read [ran]; a phone check with real cards is still to do ("Left for a real phone test", item 5). ML Kit reads lower case as printed, so for the capitals-only collector whitelist its text is raised to capitals before filtering. See docs/mobile.md.

Status (2026-11-06): set lock, Skip and Wrong card, flashlight and zoom, and scan photos are added; see "Set lock, Skip, flashlight and zoom, scan photos". Status (2026-10-28): the hybrid is built. The scanner in `web/src/scanner/` recognises the card by its **art** (ManaVault's MPL-2.0 detector and embedding models, our own glue, in a web worker), finds the card anywhere in the frame, and settles the **printing** from the printings that share that art: the only one, or the collector line read by OCR, or the person's pick. A scan never files a guessed printing. The OCR-only scanner remains as the fallback for cards the art index doesn't know (new sets, battles) and for when the recognition bundle isn't available. See "The art recognizer (built 2026-10-28)". The research below, from 2026-10-18, is kept as written.

Why it changed (Bryan, 2026-10-28): scanning is now how the collection is kept, and the OCR scanner was slow, needed the card lined up exactly, misread cards, and filed two cards under the wrong printing. That last one was a bug: a title-only read was added as Scryfall's default printing (`Collection.tsx`). It's gone; a scan without a settled printing can't be added.

Since 2026-11-01, "Check this deck" (`/decks/:id/check`) runs the same identity-only scanner over a physical deck against a list picked on the page (the current list, another configuration or version, the plan's lists and bracket builds, research builds). Each card's verdict (belongs, take out, already seen) is worked out on the device as soon as the card is recognised, shown over the camera (`ScannerView`'s `overlay` prop) with a tone and, where the browser can, a buzz. It saves nothing; see ARCHITECTURE.md, "Check this deck". Camera-loop timing on a phone still needs the real-device check below.

Since 2026-10-25, Plans, Prints, Swap sheet (and each plan deck's Changes tab) can scan either side of a now-to-after-prints swap and immediately show the replacement, add and cut reasons, destination and installed status. This mode reads identity from the saved card names plus plan names, including both faces, without a printing lookup or network price request. It changes no data. The sheet also accepts a photo or an exact typed name. Live phone-camera accuracy still needs a real device check; the measurements below use synthetic captures.

## Set lock, Skip, flashlight and zoom, scan photos (2026-11-06)

Bryan (2026-11-06), after trying Convoke's webcam scanner: the scanner should be "more consistent, less finicky, and a little bit more user-friendly"; the close-up step for the printing "was just not good". Convoke publishes nothing about its recognition beyond marketing (100,000+ labelled real game frames, retrained from players' reports); its model is paid and closed (DeckCheck licenses it). So we build on what we have, and start collecting our own labelled photos.

- **Set lock** (`setlock.ts`, `SetLockPicker.tsx`). The chip at the top of the camera says "Any set" or "Only ECC". Pick up to four sets (search by name or code, newest first; `GET /api/scan/sets`), kept per device (`yama.scan.sets`). The server sends each set's printings with their artworks (`GET /api/scan/set?code=`). The recognizer then also searches just those artworks each frame (`Recognition.pool`, below). The scanner goes on the best in-set match while it scores within 0.06 of the best match anywhere (`judgeLocked`): the right card scores the same in both, since the pool is part of the gallery, and a card that isn't in the set scores well above any lookalike in it. The printing is then chosen among the locked sets' printings with that art. Usually that's one, so it's filed with no corner to read ("It's the only printing of it in …"), and Keep adding adds it by itself. A card whose printings (of that art) aren't in the locked sets shows "X isn't in …. Is it a card from another set?". Yes settles it as usual, ignoring the lock; Wrong card offers the alternatives. A typed name never asks. When the art isn't known (a set newer than the bundle), the title is read against the locked sets' card names only, which is far easier than against all 35,000. After three cards in a row from one set, the scanner offers to lock to it.
- **Searching part of the gallery** (`gallery.ts`). The bundle's search graph is `score_i = gallery_i · embeddings[frames_i] − penalties_i`, then top 5. `readGallery` reads those three tensors out of `search.onnx` (a small protobuf reader) and scores any subset the same way in plain JavaScript. Checked against the graph on the pinned bundle with random embeddings: the same top 5 and the same scores to four decimals, about 20 ms for all 51,843 artworks on an M3 Pro [ran]. Unit test: `setlock.test.ts`. If a future bundle's graph changes shape, the lock falls back to the top 5's in-set matches.
- **Skip and Wrong card.** Skip goes to the next card and saves nothing: for checking a card's value. "Not this" used to do the same thing, and Bryan used it to skip. Wrong card opens the other cards the art might be, a name box and "Scan it again". While the printing isn't settled, the card shows the range of its English printings' market prices ("$0.25 to $3.10, by printing").
- **Flashlight and zoom** (`camera.tsx`). The flashlight shows where the browser exposes the torch (Chrome on Android; not Safari). Zoom (+ and −, 1× to 3×, or to 4× with the camera's own zoom) uses the camera's zoom where the browser exposes it. Otherwise it's digital: the view is enlarged, and the recognizer is given the middle of the frame at more of its pixels, which helps a small or far card.
- **Collector line reads** (`readCollectorLines`). Instead of one cut of the corner, up to three: at the edges the snapper found, at the detector's own corners, and a wider cut down to the card's bottom edge. The first that proves the printing wins.
- **Scan photos** (`samples.ts`, `server/src/scan_samples.rs`, migration 0068). Off unless "Save scan photos" is turned on, per device. Then each card added (or corrected, or marked wrong and scanned again) keeps the part of the frame around it, at most 640 px as a JPEG of about 30 to 60 kB, with its corners, what the scanner said and how sure it was, what the person said, the camera's resolution and the bundle version. Private to the account, capped at its newest 2,000 and 100 MB, and limited to 600 uploads an hour. Deleted from the scanner ("Delete them") or with the account. Nothing is sent anywhere else. This is the labelled real-photo set that "Left for a real phone test" asks for: an eval set first, then fine-tuning data if we train our own model.

Not measured yet: none of this has run on a phone camera. The lock's 0.06 margin and the thresholds still need the real photos the switch now collects.

Labels used below:

- **[ran]**: verified by running something on this machine (MacBook, Apple M3 Pro).
- **[read]**: read in docs or source, not executed.
- **[inferred]**: my conclusion, not checked.

## Browser OCR: PP-OCRv5 (2026-11-13)

Bryan (2026-11-13): "Tesseract.js was so-so but we need something better... it'd be great if we could do something even better just from the browser. I know other apps can." Decision: the browser's OCR is now PaddleOCR's PP-OCRv5 English recogniser with the PP-OCRv3 text detector, run by onnxruntime-web (already loaded for the art recognizer) in its own worker. Tesseract stays as the fallback: when the build has no models, when they fail to load, or when the worker fails later. The Android app's native OCR is chosen in the same place (`ocrEngine.ts`).

How it reads (`paddle.ts`): the detector (2.4 MB) finds the words in the crop as slightly turned boxes; boxes on one line are merged and the recogniser (7.8 MB) reads the line in one run, straightened and scaled to 48 px high, with greedy CTC decoding. A whitelist (the collector line's uppercase set) masks the classes that may win, like Tesseract's. A title read keeps the line with the most text; a collector block keeps every line, top to bottom. When the detector finds nothing, the crop is split into lines by rows of ink. Confidence is the mean probability of the kept characters, on Tesseract's 0 to 100 scale; nothing in the pipeline gates on it (the printing is settled by the catalog lookup and the title check, as before).

Serving: `web/scripts/paddle-models.mjs` pins the three files (recogniser, its dictionary, detector) to one commit of `monkt/paddleocr-onnx` on Hugging Face with their sizes and SHA-256 sums. The build (`copy-ocr.mjs`) downloads them once into `node_modules/.cache/yama-ocr` (or `YAMA_OCR_CACHE`), checks them, and copies them to `/ocr/paddle-<checksums>/` with a NOTICE, so a new model gets a new address (served immutable; a missing path under `/ocr/` is a 404, never the app page). A build fails if they can't be fetched or don't match; `npm run dev` goes on without them and reads with Tesseract. They are fetched only when the scanner first reads text, and the service worker keeps them like the rest of `/ocr/`. The worker shares the art recognizer's ONNX Runtime WASM file.

Measured the same way as "Measured results" below (Node 26, one WASM thread, the same 26 cards; Tesseract rerun on this machine for the times) [ran]:

| | Tesseract.js 7 | PP-OCRv5 rec + PP-OCRv3 det |
|---|---|---|
| Whole card, refined quad: card right / printing right / confident and wrong | 82% / 73% / 0 | **97% / 84% / 0** |
| Whole card, guide quad | 78% / 63% / 1 | 95% / 76% / 0 |
| Whole card, exact corners | 85% / 77% / 1 | 99% / 93% / 0 |
| Rough captures (dark, glare, blur, black mat), refined | 38% / 15% | 88% / 60% |
| 1993-2003 frames, card right | 33% | 100% |
| Close-ups: printings right / wrong / left to pick, of 26 | 19 / 0 / 7 | **20 / 0 / 6** (every card that prints a set code) |
| Close-ups: titles right, of 26 | 20 | **25** (the miss is the sideways battle) |
| Whole-card scan, refined, median / p90 ms (Node) | 258 / 424 | 294 / 605 |
| One collector block read, median / p90 ms (desktop Chrome, worker) | 70 / 143 | 150 / 220 |
| One title read, median / p90 ms (desktop Chrome) | 21 / 30 | 54 / 75 |
| Model load in Chrome, files cached | 115 ms | 280 to 520 ms |
| Download | 2.95 MB model + 2.9 MB WASM core | 10.3 MB models (ONNX Runtime WASM already loaded for the art recognizer) |

What it changed: it reads the bullet, the artist's name and small type almost exactly ("C 0145 WOC•EN DAN SCOTT"), so the set code and number come through in the rough, far and skewed captures where Tesseract read noise. Against Tesseract on the refined quad it gained 20 cards and lost one (the handheld battle, whose title runs sideways). Wrong answers stayed below the 0.8 confidence line in every run. Reading titles through the detector too (rather than the row split) took the whole-card score from 95% to 97% and upside-down scans from 88% to 100%, for about 45 ms more per frame.

What it costs: a collector read takes about twice Tesseract's time on one WASM thread, nearly all of it the recogniser (about 50 ms per line; the collector crop holds two or three lines, the artist's name included) and 43 ms for the detector. On a phone that is likely 300 to 600 ms per collector read [inferred: the 2 to 4 times laptop rule above]. Ways to cut it, not yet tried: int8 quantisation of the recogniser (smaller and faster in WASM, needs its own accuracy run), WebGPU where the browser has it, and cropping the artist's name off the collector line before reading.

Also considered: Chrome's `TextDetector` (Shape Detection API) isn't exposed in desktop Chrome 157 without a flag (`"TextDetector" in self` is false; `BarcodeDetector` is there) [ran], so it can't be the browser's engine; Android Chrome wasn't checked. PP-OCRv5's own server detector is 84 MB; the v3 mobile detector works fine with the v5 recogniser on these crops.

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

Deferred, not rejected:

- **Native OCR** (ML Kit, through a Capacitor plugin in an Android app; iOS is shelved). It is likely faster and more accurate on small print [inferred]. It is the next step if collector-line reads fail on a real phone ("Left for a real phone test", below). Keep `OcrEngine` as the seam for it.

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
- **On the phone:** the first scanner open downloads about 39 MB over the wire (detector 12.6 MB, search 13.9 MB, embed 5.1 MB, artwork index 3.2 MB, ONNX Runtime WASM 3.9 MB, gzipped where it helps), with a progress line, into the Cache API (`yama-scan-v1`, kept by `sw.js`). Later opens load from the cache. The OCR models (10.3 MB, "Browser OCR: PP-OCRv5") are loaded only when a collector line has to be read.
- **Printings that share art:** `printings.illustration_id` and `back_illustration_id` (migration 0036, filled by the `default_cards` import, importer version 3, so a running server re-imports on its next pass). Until a printing has illustration data, the endpoint returns every printing of the card (`same_art: false`); the collector line then has to read the set code exactly to settle it.
- **Cards the index doesn't know:** a bundle from 26 October doesn't know cards printed after it, and the bundle leaves out battles and art series. These score below 0.6 (wrong matches scored at most 0.58 in the eval), so the scanner reads their text instead. Move to a newer bundle by changing the tag and sums in `scan.rs` and rerunning the recognizer eval. ManaVault publishes a bundle every week or two.
- **Re-arming:** after Add (or Not this), the same artwork isn't found again until the card leaves the view or another card shows, so one card is never added twice by accident. Copies (1 to 10) are chosen on the result.
- **Keep adding (Bryan, 2026-10-28):** a switch under the camera, remembered per device. A card the camera found whose printing the scanner proved (the only printing, or the collector line read with proof) is added at once, one copy, with a buzz and "Added …" on the camera, and scanning goes on (`addsItself`). A typed name, a guessed or tapped printing still stops for Add. The same card isn't added twice until it has clearly left the view (`hold.ts`: four frames in a row with no card or only a weak match, or another card matched), so a second copy needs the first moved out of frame; one missed detection doesn't re-arm it. A card found by its text (no art match) is held by name the same way (`hold.ts`): until the detector sees no card, or another card is read twice since the held one was last read (once if near-certain). In text-only mode (no detector) four empty reads in a row, with the card unseen for 3 s, also end it; reads alternate orientations, so empty reads alone aren't proof. One misread doesn't free it, the title close-up doesn't start while it's held, and a photo skips the hold.
- **Fixing what was added:** "Added N: review" opens this session's cards, newest first, with copies, finish, Change printing and Remove. Adds merge into rows the person may already own, so a fix (`scanner/session.ts`) finds the row the add went into (Near Mint, English, same box) and takes back only this session's copies, then adds them again the new way; copies owned before are never touched. Copies of one printing are interchangeable, so the session also remembers what its own writes left in each row (`noteWrite`); if a row holds fewer when a fix is made (some taken out on another page or device), the fix is refused and points to the Collection page rather than risk taking an older copy. The session's writes run one at a time, each followed by its count lookup (three tries), and a fix's lookup, check and write run in the same queue, so overlapping saves (Keep adding the same printing twice quickly) can't muddle the counts; a fix is refused if the count couldn't be had. A row whose count was lost (lookups failed, or a retry the server reports as already applied) stays unchecked for the rest of the session, so fixes to it are refused; a later count could already miss copies taken out meanwhile. Known limit: the check and the fix are separate requests, so copies taken out on another device in the moment between them aren't caught; closing that needs a conditional op on the server, which offline-queued ops (applied later, by design) can't carry. The Collection page's own edits have the same window. The camera pauses while the list is open. Every write stays on its entry until the server confirms it, and the entry takes no other change meanwhile, from before the fix looks up its row (closing the list doesn't unlock it); a failed or unanswered write is only sent again unchanged (same op ids, applied once), so a lost reply can't double a fix. Keep adding says "Added" only after the save; a failed one stays in the list to try again.
- **Typing instead:** "Or type the name" opens the same printing picker.
- **Close-up step (Bryan's idea, 2026-10-28):** a whole card in view gives the collector line only about 1 to 2% of the frame's height, so when the first read can't settle the printing, step 2 starts by itself: a wide box replaces the card guide and asks for the phone close to the bottom-left corner. Each frame, just that box is read at full camera resolution (scaled to 200 px tall) and matched against the printings that share the art. A read of both set code and number settles it at once; set code or number alone needs the same answer twice. The picker stays below, so tapping is always an option. A printing tapped among several wasn't read from the card, so Add first asks to check the set code and number in the corner (Bryan, 2026-10-28): "Add anyway", or read it up close, which replaces the pick when it settles. Whenever the next step is a tap rather than the camera (picking a printing without a live camera, or this check), the camera's status chip turns white and says so, the phone buzzes, and the panel scrolls to it. For cards whose art isn't known, after two failed text reads (or with "Read the name up close") the scanner asks for the title the same way, then goes on to the printing.
- **Close-ups are a switch (Bryan, 2026-10-31):** "Close-ups" under the camera, on by default, remembered per device (`yama.scan.closeups`, shared by the collection and deck scans; `ScannerView`'s `closeups` prop). Bryan likes the two-step scan for handheld use, but a camera that stays put (a stand, or a feeder that drops cards under it) can't be moved to the corner. With it off, the scanner is one-step again: it reads the collector line once from the whole-card view, and if that doesn't settle the printing, it asks for a tap in the picker; an unknown card's name keeps being read from the whole card. Neither close-up starts by itself, but the "up close" buttons still start one. Turning it off ends a close-up in progress; the switch stays shown during both close-ups. Keep adding behaves the same either way: only a printing the scanner proved is added without a tap. A native app would do this differently.
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
      ─▶ collector crop, upscaled ─▶ OCR (block, uppercase whitelist) ─▶ parse set, number, language
      ─▶ title crop, cropped to its text band ─▶ OCR (single line) ─▶ fuzzy match over ~37k names
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

These are the 2026-10-18 Tesseract numbers; the PaddleOCR engine's are in "Browser OCR: PP-OCRv5".

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
| PP-OCRv5 English mobile recogniser (`en_PP-OCRv5_mobile_rec`) and PP-OCRv3 mobile detector, ONNX | Apache-2.0 (PaddlePaddle's PaddleOCR; the ONNX conversion `monkt/paddleocr-onnx` is published as Apache-2.0) [read: Hugging Face model card, PaddleOCR repo] | downloaded at build time, pinned by commit and SHA-256 (`web/scripts/paddle-models.mjs`), served by the app with a NOTICE (10.3 MB) |
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

`identityOnly` is for uses where only the card matters: the plan's swap check, scanning a whole deck (`web/src/decks/DeckScanPage.tsx`, `/decks/:id/scan`) and checking one (`web/src/decks/DeckCheckPage.tsx`, `/decks/:id/check`). It looks up no printings. With `autoAdd` (Keep adding) it adds any card the camera found unless the art also looks like another card (`addsByIdentity`); a typed name still waits for Add. `NameEntry.tsx` is the type-a-name box, also used by the deck scan page.

For other uses, the pipeline is pure:

```ts
const res = await scanFrame(imageData, { ocr, catalog, names, guide });
// res.candidates (best first), res.quad, res.raw (OCR text), res.timings
```

`OcrEngine` and `ScanCatalog` are injected: `createOcrEngine()` (`ocrEngine.ts`: PaddleOCR in the browser, Tesseract as the fallback) and `createServerCatalog()` for the app, `eval/dbCatalog.ts` (read-only SQLite) for tests.

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
| `ocrEngine.ts` | `createOcrEngine`: which OCR engine reads text, and the fallback to Tesseract |
| `paddle.ts` | `OcrEngine` on PaddleOCR (PP-OCRv5 recogniser, PP-OCRv3 detector; ONNX Runtime passed in) |
| `ocr.worker.ts`, `paddleClient.ts` | PaddleOCR in a web worker |
| `paddle.test.ts` | unit tests for its pure parts (detector boxes, line splitting, CTC decoding, fallback) |
| `tesseract.ts` | `OcrEngine` on tesseract.js (two workers), the fallback |
| `recognizer.ts` | the art recognizer: detector, embed and search graphs (ONNX Runtime passed in) |
| `art.worker.ts`, `artClient.ts` | the recognizer in a web worker; bundle download and Cache API |
| `printings.ts` | `printingOptions` (`/api/scan/printings`) and `choosePrinting` |
| `printings.test.ts` | unit tests for the printing choice and the recognizer's pure parts |
| `serverCatalog.ts` | `ScanCatalog` on the server API and the offline card bundle |
| `ScannerView.tsx`, `scanner.css` | camera screen |
| `NameEntry.tsx` | type a card's name (autocomplete) instead of scanning it |
| `dev.html`, `dev.tsx` | stand-alone page: `http://localhost:5173/src/scanner/dev.html` |
| `scanner.test.ts` | unit tests, part of `npm test` |
| `eval/` | accuracy harness: fixtures, scene simulator, DB catalog, `eval.test.ts` (OCR), `recognizer.test.ts` (art, free-hand), `embedding.test.ts` (the 2026-10-18 spike) |

Run the evals (need `data/yama.db`, or `YAMA_DB=<path>`; they download card images and models into `/tmp/yama-scanner-spike`, or `SCANNER_SPIKE_DIR`, on first run). The OCR evals read with PaddleOCR; `SCANNER_OCR=tesseract` reads with Tesseract, and `SCANNER_DUMP=<dir>` writes every crop read and its text:

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
5. **Native app (ML Kit built 2026-11-13; sideloaded, docs/mobile.md).** Compare collector-line reads in the app against the browser on the same real cards. The plan, as written before: a native scanner plugin would get the full-resolution camera with proper focus and zoom, and on-device text recognition far better on small print than Tesseract (ML Kit) behind the existing `OcrEngine` seam; the art recognizer can stay as it is. Decide after the phone test.

## Sources

- tesseract.js <https://github.com/naptha/tesseract.js>; language data <https://github.com/naptha/tessdata>
- cfbender/oracle <https://github.com/cfbender/oracle> (README, `docs/pipeline.md`, `cardid/model.py`, CONTRIBUTING); ManaVault <https://github.com/cfbender/manavault> (releases, `assets/react/src/pages/scan/recognition/pipeline.ts`, read only)
- CollectorVision <https://github.com/HanClinto/CollectorVision>; model card <https://huggingface.co/HanClinto/milo>; catalog <https://github.com/HanClinto/CollectorVisionCatalog>
- onnxruntime-web <https://www.npmjs.com/package/onnxruntime-web>
- Scryfall image guidelines <https://scryfall.com/docs/api/images>
