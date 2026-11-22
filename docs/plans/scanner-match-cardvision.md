# Matching CardVision's scanner, and a native camera for the Android app

**Status:** In progress, 21 Nov 2026 (Bryan approved it that day). Stage 5 is built (22 Nov 2026; Bryan: "let's
go ahead and do all of this"): card first, printing after (22) and tie by price (26) as options in Scan settings,
off by default; the border colour rule (24); feedback by price (28), on by default (docs/scanner.md, "Card first,
printing after, border, tie and feedback by price"). Card first's default flips only when the Pixel's timing
records (`get_scan_timings`, `rows`) support it. Stages 1 and 2 are merged and live:
the outline, the focus pin, 60 fps and "Card back" (PR #184, on by default), the placement gate (PR #186,
an option: Settling by art, "Art that leads, read when the card is still") and the app's own camera in
the Android app (PR #187). The live Pixel comparison supports making the native camera the default
on APKs with the plugin. The [ONNX model interfaces](../scanner.md#onnx-models-for-the-native-scanner)
are documented and the one-crop art export has passed desktop CPU parity. The next implementation
stage is the native finder and outline, with the Android runtime packaging decision below.
Item 20 (upside down only when doubtful) moved to stage 3 with the native finder. Two decisions below
wait on Bryan.

**Asked for:** Bryan, 21 Nov 2026, after trying CardVision's Android beta (0.2.1-beta1): "It's by far the
best one I've seen and it's the one that we should use as our gold standard but we should improve upon it
as well." Then: "Maybe we need to make a better app here, like a native app for that portion of the app
instead of the web view… The rest of it might be able to be a web app… Let's make a list here and just
try to match it."

## Ground rules

- We borrow ideas, not code, models or data. What's below comes from using the app and from the help text
  its own settings show for each option. Nothing of CardVision's ships in Yama: not its detector, its
  embedder, its index, or decompiled code. Our models stay our own (see
  [scanner-models.md](scanner-models.md)).
- The models work goes on in its own thread ("Card Scanner Backend and Model": look vectors from the
  server, the one-tap speed test). This plan owns the camera, the gate, the overlay and the native shell,
  and takes models as inputs. Model changes here are limited to exporting what already exists in the form
  the native side needs.
- The scanner's rule about printings doesn't change: a scan never files a guessed printing
  (ARCHITECTURE.md). Nothing here saves a collection row before its printing is settled by the rules
  that settle one today. Settling a tie by price is a new rule: Bryan said yes to it as an opt-in option
  on 22 Nov 2026 (below).

## Why the web view is the wrong home for the camera loop

CardVision reads a settled card in about 10 ms and looks for cards 30 to 60 times a second. Yama's
scanner runs in the app's WebView on one WASM thread: 39 ms a frame with the faster models on an M3 Pro,
more on a phone (docs/scanner.md, "Speed"). The WebView also can't reach three things the camera
offers a native app:

- the phone's virtual back camera, which switches to the ultra-wide by itself when a card is closer than
  the main lens can focus (about 20 cm);
- capture rates above 30 fps with a pinned exposure (60, 120, 240), which is what stops motion blur on a
  card still moving in the hand;
- frames at the sensor's own size without a canvas copy, and inference on the phone's GPU.

So: the camera loop moves into native code in the Android app. Everything after "this card, this
artwork" stays in the web app, where the collection, deck check and box check already live. Browsers
keep the web scanner, which gets the parts of this list that don't need native code.

## The list

"Where" says which side builds it: **web** (works in browsers and the app today), **native** (Android
app only), or **both** (shared logic in TypeScript, fed by either camera).

### Seeing the card

| # | What CardVision does | Yama today | Where |
|---|---|---|---|
| 1 | Draws an outline on every card the detector finds, at once and before it's identified; follows the card's rounded corner; fades in and out; redrawn every screen refresh; up to four cards | Draws the finder's quad before the card is named, as a plain outline updated once per recognizer pass | both |
| 2 | Looks for cards 30 times a second (12 on a quiet scene, 60 as an option); backs off when the phone is hot or saving power | The next art pass is scheduled with a set delay after the last, at WASM speed | native |
| 3 | Detector sees 320 px; the card is then cut from the full camera frame (720p, 1080p or 4K) for identification, and the collector strip separately at 8× | Similar split (frame cut up to 2400 px for text) | native |
| 4 | Looks a fifth past the visible edge, so a card is found before it's fully in view; an optional box you drag limits where it looks | Whole frame | both |
| 5 | A debug view of what the detector and the gate see | Scanner diagnostics records, no live view | both |

### Deciding when to read

| # | What CardVision does | Yama today | Where |
|---|---|---|---|
| 6 | Measures the card's speed over 100 ms and reads when it's still | Reads every frame; settles on rules over several frames (`LEAD_FRAMES`, `UNTITLED_FRAMES`) | both |
| 7 | A placement is latched: a card lying still is read once, however long it lies there | `hold.ts` holds the card just filed until it has left | both |
| 8 | A small thumbnail of the placement proves "same card came back" against "new card", so the wait between reads is 50 ms | Time and miss counts | both |
| 9 | Scores each frame's sharpness, waits briefly for a sharper one, and reads the sharpest frame of the placement | `quality.ts` skips blurred collector strips | both |
| 10 | Five tries per placement, then "no match, move the card" | Time budgets (`HOLD_BUDGET`) | both |
| 11 | The same printing isn't logged again within 3 s unless the card left | "+1 copy" on the camera | both |

### The camera

| # | What CardVision does | Yama today | Where |
|---|---|---|---|
| 12 | Uses the virtual camera that switches lens by distance; Main, Ultra-wide and Telephoto can be picked | A lens picker over what the browser lists; zoom capped under the telephoto switch | native. Whether the virtual camera switches at close range is up to each phone's maker, so it is checked on the Pixel, and a manual Ultra-wide choice is the fallback |
| 13 | Capture rate 30 to 240 fps, exposure pinned under it | Whatever the browser gives | native: 60 fps in an ordinary session. 120 and 240 are Android's high-speed video sessions, which CameraX offers without a frame-analysis stream and Camera2 only with automatic exposure and video autofocus, so they are out until a phone shows otherwise |
| 14 | Autofocus biased to near; an optional focus slider that pins the lens | Asks for continuous autofocus and focuses on the collector corner where the browser allows; no manual control | web (where Chrome exposes it), native |
| 15 | Torch with strength | Torch on or off | native |
| 16 | Pinch to zoom | Has it | done |

### Naming the card

| # | What CardVision does | Yama today | Where |
|---|---|---|---|
| 17 | One embedding of one crop per read | 2 cuts first, 15 more when unsure (option). One crop needs a new art model with its own gallery: today's gallery holds one vector per artwork per frame style | models thread |
| 18 | Says "card back, turn the card over" | Nothing | both |
| 19 | Trims a sleeve's edge and reads once more when a read is refused | Art model trained on sleeves | both |
| 20 | Reads upside down only when upright is doubtful | Detector tries four turns every pass (default finder) | both |
| 21 | One calibrated score from several signals decides accept or refuse | Lead rule and thresholds in `fuse.ts` | later |

### Naming the printing

| # | What CardVision does | Yama today | Where |
|---|---|---|---|
| 22 | The card is logged at once; the printing is worked out after, only when unsure, and the row updates itself | Built 22 Nov 2026 as an option (Card first, printing after); off, the card waits in the sheet until its printing settles | web |
| 23 | Set symbol matched against templates per set and rarity | The printing look model | models thread |
| 24 | Border colour rules printings out (black against white) | Built 22 Nov 2026: says black or white only when the border differs from the table, so silent on a dark mat | web |
| 25 | Collector number read by ML Kit, only on unsure reads | ML Kit in the app, evidence scoring | done |
| 26 | Printings that can't be told apart and cost nearly the same: takes the dearest, marks it "by price" | Built 22 Nov 2026 as an option (Tie by price, off by default); off, it asks | web |
| 27 | Foil can't be seen: assumes a finish, tap the price to flip | Finish picker per card | keep ours |

### Feedback

| # | What CardVision does | Yama today | Where |
|---|---|---|---|
| 28 | A quiet haptic per find, a different one for a valuable card; a chime pitched by price | Built 22 Nov 2026 (Feedback by price, on by default) | web |
| 29 | Times the phone at start and says so when it's slow | One-tap speed test (being built in the models thread) | models thread |
| 30 | Checks the GPU's answers against the CPU's before trusting it | n/a | native |

## How the native camera fits

A Capacitor plugin in the Android app (`web/android`, beside `TextReaderPlugin`) owns:

- the camera (CameraX with Camera2 interop for lens, capture rate, focus and torch);
- the preview, drawn natively behind a transparent WebView, so the web scanner's sheet and controls sit
  over it. The scanner's own camera layers (`.scan`, `.scan-camera` in `scanner.css`) paint opaque
  backgrounds today and have to go clear while the native camera is open;
- the card finder on every analysed frame (ONNX Runtime for Android, our `yama-corners` model);
- the outline, drawn natively from the latest corners so it keeps up with the screen;
- cutting the card from the full frame and running the art model on it when asked.

It reports to the web side: the corners of each card every pass, and on request the art embedding and
the crops (card, collector strip, set symbol area) of the frame it kept as sharpest. The gate (items 6
to 11), the search, the printing rules and everything on screen below the camera stay in TypeScript, in
one implementation that takes its frames from either the browser camera or the plugin. That seam is the
first thing built, so the gate is written once.

What the models are, for the native side (from the models thread, 21 Nov 2026):

- **Card finder** (`yama-corners-20261120.onnx`): a fixed 256 × 256 RGBA window in, the four corners,
  an "up" vector (its length is how sure it is that a card is there), the centre and the short side out.
  ONNX Runtime for Android runs it as it is. The window logic around it (a tracked frame reuses the last
  card's box, a fresh one searches in two passes) is code in `recognizer.ts` and has to be written
  natively too. A 320 px input would mean retraining, not a re-export.
- **Art model:** the shipped graph takes the whole frame and the corners and does the cuts in the graph,
  so stage 4 can use it as the CPU reference. The fixed one-crop export takes a normalised 128 × 128 RGB
  crop and returns a 128-element embedding. The native warp and frame-style cuts must match the reference.
- **GPU:** ONNX Runtime for Android has no general GPU backend, so the GPU route is LiteRT's GPU
  delegate with the models converted to `.tflite` by the models thread. The shipped art graph warps
  the card inside the graph (GridSample), which LiteRT's GPU delegate doesn't list, so on that route
  the warp is done in native code and only the network runs on the GPU. Nothing has been measured on
  Android. On a Mac in Chrome, with the faster models, four WASM threads took a frame from 38.5 ms to
  29.8 and WebGPU to 33.0 (docs/scanner.md, "Speed"), which suggests the accelerator is worth little
  while the models are this small and the native gain comes first from dropping the canvas copy and
  the WebView. The Pixel's own ML chip is not
  pursued, and its terms forbid publishing timings for it (docs/plans/scanner-models.md).

A change to native code changes the app's native hash, so each stage that touches it ships as a new APK
through the app's own updater (docs/mobile.md).

## Order

1. **Web, no native code:** outline on detection (1), the placement gate with sharpest-frame pick (6 to
   11), the focus slider and a 60 fps request where the browser allows (14), card back and upside-down
   handling (18, 20). Behind a camera-source seam. Works in browsers and the app as it is.
2. **Native camera:** the plugin with preview, lens, capture rate, focus and torch (12 to 15), handing
   frames to the existing web recognizer. No native inference yet. This alone gets the lens choice,
   the higher capture rate and manual focus.
3. **Native finder and outline:** the card finder and the outline in native code (1 to 4), corners sent
   to the web gate. The web recognizer finds and matches in one call (`identify(frame)`), so this
   stage also gives it a way to match a card at corners it is handed; otherwise both finders would
   run. `yama-corners` returns one card per window, so more than one outline at a time needs the
   window logic to track several cards, or a finder that returns several: one outline first.
4. **Native art read:** cut and embed natively, first on the CPU with the shipped files, then on the
   GPU through LiteRT with a CPU check if a phone's numbers ask for it (17, 30). The web side searches.
5. **Printing after the row** (22, 24), then feedback by price (28). The row shown at once is
   provisional: it is on screen and in the session, and it is saved to the collection only when its
   printing settles (the collection can't save a row without a printing). Item 26 joined it as an
   opt-in option (Bryan, 22 Nov 2026). Built 22 Nov 2026.

Each stage is its own PR with a phone check on Bryan's Pixel recorded by Scanner diagnostics' timing
records. A stage's default flips only when those records support it; until then it's an option in Scan
settings, as the faster models are.

## Decisions for Bryan

- **Settle a tie by price (26).** Decided 22 Nov 2026 (Bryan: "let's go ahead and do all of this"): an
  opt-in option, off by default, marked "by price" wherever the card shows, undone by Wrong printing.
  CardVision files the dearest of printings it can't tell apart when they're within 15% of each other.
- **App size.** ONNX Runtime for Android adds roughly 15 to 30 MB per processor type, and the app ships
  three. Proposed: accept it for arm64 and x86_64 (emulator), and drop 32-bit ARM from the scanner's
  native path (those phones keep the web scanner).

## Where we should end up ahead

- Foil and finish: CardVision assumes; Yama records every finish and names special foils.
- Its close-call check is a 921 MB download; the printing look does that job in a few MB.
- A scan here lands in a collection, a deck check or a box check, not a list to export.
