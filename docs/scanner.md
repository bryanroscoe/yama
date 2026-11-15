# Card scanner

Status (2026-11-15): the art bundle is `gallery-20261106T183001884398Z`, which knows Star Trek and Star Trek Commander; see "Bundle gallery-20261106 (2026-11-15)".

Status (2026-11-13): inside the Android app the scanner reads text with **ML Kit** (`mlkit.ts`, `TextReaderPlugin.java`; picked by `ocrEngine.ts`); in browsers it reads with PaddleOCR's PP-OCRv5 models (ONNX Runtime, in a worker), with Tesseract as the fallback (see "Browser OCR: PP-OCRv5"). On the Android 16 emulator ML Kit read the collector line of five Scryfall scans (MOM 214, WOC 145, ECC 57, DMU 107, CMM 1) and each parsed to the right set and number, in 7 to 66 ms per read [ran]; a phone check with real cards is still to do ("Left for a real phone test", item 5). ML Kit reads lower case as printed, so for the capitals-only collector whitelist its text is raised to capitals before filtering. See docs/mobile.md.

Status (2026-11-06): set lock, Skip and Wrong card, flashlight and zoom, and scan photos are added; see "Set lock, Skip, flashlight and zoom, scan photos". Status (2026-10-28): the hybrid is built. The scanner in `web/src/scanner/` recognises the card by its **art** (ManaVault's MPL-2.0 detector and embedding models, our own glue, in a web worker), finds the card anywhere in the frame, and settles the **printing** from the printings that share that art: the only one, or the collector line read by OCR, or the person's pick. A scan never files a guessed printing. The OCR-only scanner remains as the fallback for cards the art index doesn't know (new sets, battles) and for when the recognition bundle isn't available. See "The art recognizer (built 2026-10-28)". The research below, from 2026-10-18, is kept as written.

Why it changed (Bryan, 2026-10-28): scanning is now how the collection is kept, and the OCR scanner was slow, needed the card lined up exactly, misread cards, and filed two cards under the wrong printing. That last one was a bug: a title-only read was added as Scryfall's default printing (`Collection.tsx`). It's gone; a scan without a settled printing can't be added.

Since 2026-11-01, "Check this deck" (`/decks/:id/check`) runs the same identity-only scanner over a physical deck against a list picked on the page (the current list, another configuration or version, the plan's lists and bracket builds, research builds). Each card's verdict (belongs, take out, already seen) is worked out on the device as soon as the card is recognised, shown over the camera (`ScannerView`'s `overlay` prop) with a tone and, where the browser can, a buzz. It saves nothing; see ARCHITECTURE.md, "Check this deck". Camera-loop timing on a phone still needs the real-device check below.

Since 2026-10-25, Plans, Prints, Swap sheet (and each plan deck's Changes tab) can scan either side of a now-to-after-prints swap and immediately show the replacement, add and cut reasons, destination and installed status. This mode reads identity from the saved card names plus plan names, including both faces, without a printing lookup or network price request. It changes no data. The sheet also accepts a photo or an exact typed name. Live phone-camera accuracy still needs a real device check; the measurements below use synthetic captures.


**Blank views (2026-11-13).** On Bryan's Pixel 3 a plain white view was "Found" as Whiteout (Mystery Booster 2 #77, whose art box is printed blank): the detector took the white sheet for a card, and blank matched blank. The recognizer now also asks how much is printed inside what it found (`cardDetail` in `recognizer.ts`: the mean brightness step between neighbouring 5 × 5 averages on a 32 × 44 grid inside the card) and treats anything under `MIN_DETAIL` (4) as no card. Measured [ran] on Scryfall scans: 12 cards scored 15 to 34 (MB2 Whiteout 15.4, Alpha Black Lotus 15.7), and 11 to 24 shrunk to 220 px wide and blurred; a synthetic white sheet with a lighting gradient scored 0.6 to 2.5 with sensor noise up to σ 12. A real Whiteout is still recognised (its frame, title and rules text count). The recognizer eval was not rerun for this (no bundle on this machine); the change can only turn a found card into "no card", and every card measured is at least three times over the line.

**Hold and read (2026-11-15).** Bryan, on his Pixel 10 Pro: "I want to just hold and scan the card and get all the details of the card... I don't want to have to move the card", with the close-up kept as something to ask for, not a step every time. So when several printings share the art and the first read of the collector line doesn't settle it, the scanner keeps reading (`heldRead.ts`, the hold loop in `ScannerView`): each frame it finds the card again with the art recognizer, cuts the card from the camera's full-resolution frame (`around`, up to 2400 px; the camera asks for 3840 × 2160) and reads the collector line the three ways `readCollectorLines` does. A read that proves the printing settles it. Otherwise three frames must name the same printing (`AGREE`; the close-up asks for two, from several times more pixels). Frames that read nothing don't break a run; a frame naming another printing starts a new one. With Close-ups on, the close-up box takes over after six frames (`CLOSEUP_AFTER`); with it off, the scanner reads for up to 40 frames and then leaves the picker. The held card has to stay the best match in view (within 0.02 of it, or 0.06 with the set lock), so a different card held up next isn't read against this card's printings. If the card is out of view for four frames in a row, or four reads in a row fail, it stops; it also pauses while "Wrong card" is open. The picker and "Read the collector number up close" stay shown throughout. A card found by its text (no art match) still goes to the close-up at once. Not measured on a phone yet; the frame counts are guesses to tune with real scans. Scan settings also names the text reader in use (ML Kit, PaddleOCR or Tesseract; `ENGINE_LABEL` in `ocrEngine.ts`), so you can tell which one a device has.

**Tap to file, and the corner in the sheet (2026-11-15).** Bryan, on his Pixel 10 Pro, after tapping a printing was followed by two or three more confirms before the card was filed: tapping the printing is the confirmation. Decision (supersedes the 2026-10-28 "Add first asks to check the set code and number" rule in "The close-up step" below): a printing tapped in the list is filed at once, the same way Add files it (`file` in `ScannerView`: the Copies value, 1 unless changed, with the chosen finish and box), and scanning goes on to the next card, with or without Keep adding. The way back is Wrong card before tapping, and Undo after: the camera's "Added …" chip offers Undo for six seconds once the save is confirmed (Collection only, `onUndo`; it is the Added list's Remove, `removeFix` in `session.ts`, so it takes back exactly the copies just filed). The rescan from a collection item (`single`) uses the tapped printing at once too; deck scans, deck checks and swap checks file by identity and have no printing list, so they're unchanged. A kept scan photo of a tapped printing still says it was picked, not read: its `guess_scryfall_id` is empty (the scanner settled nothing) and `label_scryfall_id` is the tap. Bryan also found the sheet covering the bottom of the camera picture, where the set code and number are, so he couldn't read them himself while choosing: the top of the printing list now shows "From your card", that corner cut from the camera's own frame the way the text reader cuts it (`peek.tsx`, the wide collector cut with the rarity line above, at the card's own resolution, never enlarged past it, in colour as captured), following the latest frame while the scanner reads the held card. And "Read the collector number up close" no longer runs into "Your turn: tap the printing" at phone width: the sheet's rows were shrinking into each other when it held more than fits (a flex column with `max-height` and a link button with `min-height: 0`); they now keep their height and the sheet scrolls (`scanner.css`).

**Scan anyway, and More (2026-11-15).** Bryan scans real duplicates (two of a card from two orders), and the scanner held the second back as the card just added ("Ready for the next card", `hold.ts`: `blocked` for a card found by its art, `blockedName` for one read as text). So while the card just filed is still held, the sheet says so and offers **Scan anyway**: one more copy, the same printing and finish, through the same path as Add (`file` in `ScannerView`), with the camera's Undo as after any add; the card stays held, so each press is one copy and it's never added again by itself. It isn't offered on a one-card rescan (`single`). No host refuses a copy because the collection already has one (Collection merges it into the row; deck scans and checks count it and flag a second copy), so this is the only place it was held back. Bryan also asked for a less cluttered sheet: the ways in he doesn't use on every card are now in a **More** menu (the app's `MoreMenu`: a button labelled More, plain text items, a bottom sheet on a phone): "Use a photo" and "Read the name up close" while scanning, "Read the collector number up close" under a found card's Add and Skip, beside Wrong card. Nothing was removed; the card, its printing, Add, Skip, Wrong card, the typed name and Undo stay in view. The photo's file box stays mounted outside the menu, so picking the item (which closes the menu) still opens it.

**Title first when the art isn't sure (2026-11-15).** Bryan: "none of the Star Trek cards scan". Two causes, measured [ran]:
- **The art index didn't know them.** Star Trek (TRK, TRC) came out on 13 Nov, after the pinned bundle of 26 Oct. #141 moves the pin to ManaVault's 6 Nov bundle, which has every TRK and TRC artwork.
- **The decision rule.** The scanner locked a card on art at 0.82 on one frame, or at 0.62 on two agreeing frames, and read text only after three frames below 0.5. A card it couldn't recognise therefore either locked onto a lookalike or sat on "Hold still: <guess>?" in the 0.50 to 0.62 band for ever. On Bryan's Pixel 10 Pro the same day, his right answers scored only 0.64 to 0.70. A foil SOI Westvale Abbey (scan photo 9288fda7) locked Wei Night Raiders at 0.658 over two frames; Westvale itself came second at 0.634.

Now (`readTitleFirst`, `knownArtShare` in `setlock.ts`): below 0.82, the card's title is read first, on every frame, and a sure read (0.95 once, or 0.6 on two agreeing frames, as before) names the card. Art agreeing over two frames decides only when no title was read. When the scanner is locked to sets whose art the index mostly doesn't know (`setPool`'s count against the sets' artworks, under 90%), a match outside those sets is ignored and the title decides. "Hold still: <guess>?" became "Hold still, reading the name".

Measured with the 26 Oct bundle on 21 TRK and TRC cards Bryan owns, each in 7 simulated captures (147 scans; `eval/trk.test.ts`; numbers from the run that day) [ran]:
- **Before:** the right card 52%, a wrong card 14%, stuck on "Hold still" 33%.
- **After, unlocked:** the right card 97%, a wrong one 0%.
- **After, locked to TRK:** the right card 89%.

Bryan's Westvale photo, through the same steps (`eval/sample.test.ts`): the title read gives "Westvale Abbey // Ormendahl, Profane Prince" at 0.90, so it is named right. The collector line in a 640 px kept photo is too small to read, which is why the diagnostics keep full-resolution strips.

**Reading by evidence, Wrong printing, reading after a typed name, and the stuck band (2026-11-15).** Bryan, on his Pixel 10 Pro: "the printing read gives up too early"; he kept pressing retry. When the scanner settled a printing on its own it was sometimes wrong, with no quick way to say so, before or after the card was filed. When he typed a card's name (a stack whose art wasn't recognised) he wanted the printing read from the live camera too, without the close-up box. And he saw "placeholder text" in the scanner. A consult on the scanner (same day) added: accumulate evidence instead of counting agreeing frames; skip frames too blurred or glared to read; read the title when the art isn't sure. So:

- **Evidence, not a run of agreeing frames** (`evidence.ts`). Each candidate printing says what its collector line should show: number with any promo suffix, set code (The List's: the original's, from "MOM-214"), rarity letter, language. Every crop of every frame is scored against that, token by token. A token read as printed scores 1; one matching only through OCR lookalikes (0/O/D/Q, 1/I/L/T, 5/S, 8/B, 2/Z, 6/G, 4/A, U/V) scores 0.7; one lookalike edit away scores 0.3. The best per field in a frame is weighted (number 1.5, set 1, rarity 0.25, language 0.25) and added to the printing's total.
  - A token counts for one field only: the number comes from a token that looks like a number (digits, or digit lookalikes with at least one real digit, and at most a suffix letter), the set code from one with a letter in it, never the same token for both. (Review of 15 Nov 2026: "SLD" had matched SLD #510's number through lookalikes.)
  - A printing is settled when its total is at least 2.4, it leads the next by 1.5, it holds 0.9 of a softmax posterior (temperature 3), each field it prints was read at least 0.6 in some frame, and at least one of them was read exactly as printed with the other at least through lookalikes. Lookalike-only reads ("O14S W0C") order the picker and show progress, and never settle (nor does Keep adding file them). Frames before M15 (July 2014) print no set code, so there an exactly read number is enough.
  - So one clean read of set code and number still settles at once, as a proving read did. A stray frame naming another printing no longer resets anything. A set code read in one frame adds up with a number read in another. A number or a set code alone never settles it, however often it's read.
  - **Twins:** a printing from The List prints the original's set and number, and OCR easily drops a promo suffix (107p, 107s). When another candidate shows the same set and number, reading them is no proof, and the card is left to the picker, unless the leader's own suffix was read. A card found by its text has its collector line weighed the same way, as one frame (`proofOf`): it proves the printing only when the evidence would settle it, never from the text reader's confidence, which is about the card (re-review of 15 Nov 2026: "O14S W0C • EN" under a clear "Arcane Signet" scored 0.97 and had been taken as proof of WOC #145). Otherwise that printing goes first in the list and the read is the first frame of hold and read. Card identity still comes from confidence (a text read locks on 0.95 once or 0.6 twice; identity-only hosts file a text-found card at 0.8): that names the card, not its printing. A set's promo set ("psoi" for SOI, "pwoe" for WOE: prerelease and promo-pack cards; or any set the API names as a promo set's parent) prints the set's own code, so SOI 281 and the prerelease promo 281s are twins, as are WOE 82 and 82p. Mystery Booster (mb1, fmb1, mb2) and The List print the original printing's set and number; The List's numbers say which ("MOM-214"), Mystery Booster's don't, so a Mystery Booster printing among the candidates is a twin of all of them: nothing settles by itself unless its own code was read exactly [inferred]. `/api/scan/printings` doesn't send `parent_set_code` yet (the server has it in `calendar_sets`); until it does, promo sets are known by the "p" + set code pattern.
  - **The whole bottom strip** is read: after the bottom-left cuts, the bottom right too (`RIGHT_COLLECTOR_REGION`), where some showcase, borderless and promo frames and two-faced cards' backs put the line. A "number/total" counts only with a plausible set size as the total (at least 20, and at least the number: "281/297"); anything else with a slash is power and toughness (the "9/7" of a back face) and is dropped (`withoutTotals`).
  - The first read's crops are its first frame, and that evidence carries into hold and read. The close-up box weighs its reads the same way.
  - All the weights and thresholds are first guesses [inferred]; `evidence.test.ts` covers lookalikes, a stray frame, split fields, one field alone, the margin, The List and promo suffixes.
- **What it has read so far** shows in the sheet while it reads: "Read the set code (WOC), not the number yet", "Read the number (145), not the set code yet", "Read WOC 145; checking it against the other 31 printings", or that another printing shows the same.
- **Blurred and glared frames are skipped before reading** (`quality.ts`): the variance of the Laplacian of the collector strip, cut at twice the size and averaged 2 × 2 so sensor noise doesn't pass for edges, and the share of its pixels clipped to white.
  - Measured on synthetic frames of 15 cards, 900 px tall, at six blurs [ran] (`eval/quality.test.ts`, PaddleOCR): every frame that read scored 70 or more (blur up to σ 1.8); from σ 2.4 one frame in 45 read, and they scored 56 to 84.
  - So the strip must score 65, which skips only frames that wouldn't have read there. The two overlap, so it can't catch every unreadable frame. Clipped: at most 20% [inferred].
  - A skipped frame keeps the card counted as in view but isn't a frame read toward the budgets.
- **Time, not frames, as the outer cap** (`heldRead.ts`, `HOLD_BUDGET`, every number in one place). The first budgets were frame counts: 6 frames before the close-up took over, 40 before giving up, 4 missed frames to stop. On a phone reading three crops a frame that came to one or two seconds, ten at most, and under a second without the card. Now:
  - with Close-ups on, the close-up box takes over after 8 s and at least 6 frames read;
  - with it off, the scanner reads for 25 s and at least 12 frames before leaving it to the picker;
  - the card may be out of view (or another card seen) for 2.5 s before an attempt stops, and 8 failed reads in a row stop it too;
  - a card not yet held up (a typed name) gets 10 s to appear;
  - the frame counts keep a slow phone reading long enough, but at twice the time an attempt is over whatever the count or the frames said (every frame skipped as blurred, or every read failing; `capped`), and every verdict, from a read, a skipped frame or a failed read alike, is acted on.

  These are guesses [inferred]: frame rate differs by phone and by text reader.
- **Every retry is a full attempt.** The attempt is tied to the card as found and a retry counter. A new card, any change to it, Wrong printing, coming back from the close-up box ("Back to reading the whole card", new) or **Keep reading** (in the printing prompt once an attempt has given up; "Read printing" before one has run) starts again with the whole budget and fresh evidence.
- **Wrong printing.** When the scanner settled the printing itself (read from the collector line, the only English printing, or the only one in the locked sets), the found card says "Wrong printing?" instead of "Change printing".
  - It reopens the list, marking the misread "Read as this". When the first list held only that printing, the list is every printing of the card. It reads the held card again as a fresh attempt, and Keep adding won't file that card by itself.
  - **After filing,** the camera's "Added …" chip offers Wrong printing next to Undo, where the host can correct a copy (`onCorrect`; Collection). The card comes back with its list, the filed printing marked "Added as this", plus "Change to this printing" and "Keep it as it was". Tapping a printing changes the copy already filed (`printingFix` in `session.ts`, the Added list's own fix): this session's copies leave the wrong printing's row and are added under the right one, so none is left behind and none is added twice. The chip then says "Changed to …" (or "Kept …" when the host says the copy already was that printing) with Undo for that copy, and "Scan anyway" stays a new copy of the corrected printing. When the host can't confirm the change, the chip says so and points to the Added list, which holds the change and tries it again, with no Undo, Wrong printing or Scan anyway on a printing the scanner can't vouch for.
  - The Added list's "Change printing" is now "Wrong printing?", with the filed printing marked "Added as this".
  - A kept scan photo of a correction says "corrected", with what the scanner said as the guess (`sampleKind`).
- **Reading after a typed name, and for a card read as text.** These go to the same hold and read as a card found by its art, limited to that card's printings, instead of the close-up box at once.
  - The card isn't found again by its art (that's what failed), so it's found by where it is: the detector's outline, which is the card's even when its art isn't known. `pickHeldQuad` takes the largest, nearest the middle; `sameHeldCard` lets it drift in the hand but not jump (under 35% of its diagonal and 40% in size between frames).
  - A frame where it jumps, or where the art is clearly another card (0.82 or more), counts as the card not seen. With no recognizer (text mode), the on-screen guide is where the card is.
  - A pool search over the typed card's own artworks (as the set lock does) isn't used yet.
- **The stuck band, and a weak art lock** (`fuse.ts`). A card scoring 0.50 to 0.62 used to show "Hold still: <name>?" for as long as it was held. Now the title is read first whenever the art is under 0.82, or the scanner is locked to sets whose art the index mostly doesn't know and the match isn't one of theirs (`readTitleFirst` in `setlock.ts`, from the Star Trek fix), or two different cards score within 0.03 (`needsTitle`). The upright title is read and fused with the art first; with no clear title, the card's whole text is read one orientation per frame (sideways battles, upside down), as before.
  - Evidence from Bryan's phone (a kept scan photo, 15 Nov 2026, 21:03 UTC; the camera delivered 2160 × 3840): a foil Westvale Abbey // Ormendahl (SOI 281) in a blue box locked as Wei Night Raiders (PTK 89) at 0.658 on two frames, with its title "Westvale Abbey" plainly readable. His right matches in the same session scored only 0.64 to 0.70 (Bridge from Below 0.675, Buried Alive 0.642, Drowned Catacomb 0.684, Drumbellower 0.638). So on his phone two frames agreeing at 0.62 aren't evidence. Below 0.82 the art now decides only when the title agrees, or after 4 frames of the same match whose title couldn't be read at all (`UNTITLED_FRAMES`) [inferred].
  - A title read of one face ("Westvale Abbey") is the two-faced card's full name, and an art match of either face's illustration resolves the card (`titleRead`, `fuseTitle`).
  - A card just filed by its name stays held (`blockedName`): neither its art, nor a title read naming it, nor the two-frame fallback files it again (`sameCardName`, from the title-first change, now matching on any face so a back face's art counts; `fusedHeld`). Title reads keep their own two-frame history (`lastText`), apart from the art's.
  - A clear title (name match 0.85 or more, 0.08 ahead of the next name) that names one of the art's matches settles that card. One that names a card the art doesn't have vetoes the art, and the card is taken by its title (then its printing is read as for a typed name). An unclear title leaves the art's own rule (0.82 once, 0.62 on two frames).
  - This is the first piece of one scorer for card and printing; thresholds [inferred].
- **Placeholder copy** (Bryan: "the scanner shows placeholder text"; he didn't say where). Changed, old → new:
  - "Hold still: <card name>?" (the text read loop, and the art loop's 0.50 to 0.62 band): → "Hold still, reading the name" (the wording of the Star Trek fix, which this builds on).
  - The found card's picture before a printing is chosen (a grey box with the card's name in it): → an empty grey card shape; the name is the heading beside it.
  - The printing list's pictures when a printing has none (the card's name in a grey box): → an empty grey card shape; the set and number are under it.
  - The Added list's pictures without an image (the card's name, and the printings' names, in grey boxes): → empty grey card shapes.
  - The set lock's search box placeholder "Edge of Eternities, ECC…" (sample data): → no placeholder; the label above it says "Set name or code".
  - Kept: "Or type the name" (real instruction), "Wrong card?" and "Wrong printing?" (actions), "What the scanner saw" (collapsed, the raw reads, for checking a misread).

**The sheet (2026-11-13).** Bryan, on the Pixel 3: "All this extra question stuff should be a tapable expandable thing. There should be a pinch-to-zoom on the picture too. I should be able to drag away this huge bottom drawer if I want as well." So (`sheet.tsx`): the choices that rarely change (finish, where cards go, Keep adding, Close-ups, Mute, Save scan photos) sit in one "Scan settings" row that shows what's set and opens with a tap, remembered per device (`yama.scan.settingsOpen`); progress notes and errors stay in view (`ScannerView`'s `controls` against `settings`). Two fingers on the camera pinch its zoom, within the camera's own range or 1× to 3× digital, alongside the + and − buttons. The sheet has a handle: drag it down to hide the sheet and see the whole camera, drag it up or tap it (or Enter) to bring it back; a card that needs a tap brings it back by itself.
## Set lock, Skip, flashlight and zoom, scan photos (2026-11-06)

Bryan (2026-11-06), after trying Convoke's webcam scanner: the scanner should be "more consistent, less finicky, and a little bit more user-friendly"; the close-up step for the printing "was just not good". Convoke publishes nothing about its recognition beyond marketing (100,000+ labelled real game frames, retrained from players' reports); its model is paid and closed (DeckCheck licenses it). So we build on what we have, and start collecting our own labelled photos.

- **Set lock** (`setlock.ts`, `SetLockPicker.tsx`). The chip at the top of the camera says "Any set" or "Only ECC". Pick up to four sets (search by name or code, newest first; `GET /api/scan/sets`), kept per device (`yama.scan.sets`). The server sends each set's printings with their artworks (`GET /api/scan/set?code=`). The recognizer then also searches just those artworks each frame (`Recognition.pool`, below). The scanner goes on the best in-set match while it scores within 0.06 of the best match anywhere (`judgeLocked`): the right card scores the same in both, since the pool is part of the gallery, and a card that isn't in the set scores well above any lookalike in it. The printing is then chosen among the locked sets' printings with that art. Usually that's one, so it's filed with no corner to read ("It's the only printing of it in …"), and Keep adding adds it by itself. A card whose printings (of that art) aren't in the locked sets shows "X isn't in …. Is it a card from another set?". Yes settles it as usual, ignoring the lock; Wrong card offers the alternatives. A typed name never asks. When the art isn't known (a set newer than the bundle), the title is read against the locked sets' card names only, which is far easier than against all 35,000. After three cards in a row from one set, the scanner offers to lock to it.
- **Searching part of the gallery** (`gallery.ts`). The bundle's search graph is `score_i = gallery_i · embeddings[frames_i] − penalties_i`, then top 5. `readGallery` reads those three tensors out of `search.onnx` (a small protobuf reader) and scores any subset the same way in plain JavaScript. Checked against the graph on the pinned bundle with random embeddings: the same top 5 and the same scores to four decimals, about 20 ms for all 51,843 artworks on an M3 Pro [ran]. Unit test: `setlock.test.ts`. If a future bundle's graph changes shape, the lock falls back to the top 5's in-set matches.
- **Skip and Wrong card.** Skip goes to the next card and saves nothing: for checking a card's value. "Not this" used to do the same thing, and Bryan used it to skip. Wrong card opens the other cards the art might be, a name box and "Scan it again". While the printing isn't settled, the card shows the range of its English printings' market prices ("$0.25 to $3.10, by printing").
- **Flashlight and zoom** (`camera.tsx`). The flashlight shows where the browser exposes the torch (Chrome on Android; not Safari). Zoom (+ and −, 1× to 3×, or to 4× with the camera's own zoom) uses the camera's zoom where the browser exposes it. Otherwise it's digital: the view is enlarged, and the recognizer is given the middle of the frame at more of its pixels, which helps a small or far card.
- **Collector line reads** (`readCollectorLines`). Instead of one cut of the corner, up to three: at the edges the snapper found, at the detector's own corners, and a wider cut down to the card's bottom edge. The first that proves the printing wins.
- **Scan photos** (`samples.ts`, `server/src/scan_samples.rs`, migration 0068). On unless "Save scan photos" is turned off, per device (it was off by default until 2026-11-15, when Bryan asked for it on: the kept photos are the evidence the misread and diagnostics work needs; a device that had turned it off keeps it off). Since the same day the photos are shared with Yama's developer (Bryan: "I want them to send it to me"): the switch, What's new and the privacy page say so, the scanner sends `shared: true`, and an admin reads them on the admin area's Scan photos page, through `GET /api/admin/scan-samples` (paged, `?owner=&since=&before=`) and `/api/admin/scan-samples/{id}/image`, or exports them on the server with `yama-server scan-samples-export DIR [--since DATE] [--owner USER_ID]` (JPEGs and `manifest.jsonl` with user id, date, kind, label and guess). Only the card photo is shared, never a full frame. Photos saved before (marked 0 by migration 0092; the switch had promised they were shown to no one) are never shown to an admin. Then each card added (or corrected, or marked wrong and scanned again) keeps the part of the frame around it, at most 640 px as a JPEG of about 30 to 60 kB, with its corners, what the scanner said and how sure it was, what the person said, the camera's resolution and the bundle version. Private to the account, capped at its newest 2,000 and 100 MB, and limited to 600 uploads an hour. Deleted from the scanner ("Delete them") or with the account. Nothing is sent anywhere else. This is the labelled real-photo set that "Left for a real phone test" asks for: an eval set first, then fine-tuning data if we train our own model.

Not measured yet: none of this has run on a phone camera. The lock's 0.06 margin and the thresholds still need the real photos the switch now collects.

Labels used below:

- **[ran]**: verified by running something on this machine (MacBook, Apple M3 Pro).
- **[read]**: read in docs or source, not executed.
- **[inferred]**: my conclusion, not checked.

## Browser OCR: PP-OCRv5 (2026-11-13)

Bryan (2026-11-13): "Tesseract.js was so-so but we need something better... it'd be great if we could do something even better just from the browser. I know other apps can." Decision: the browser's OCR is now PaddleOCR's PP-OCRv5 English recogniser with the PP-OCRv3 text detector, run by onnxruntime-web (already loaded for the art recognizer) in its own worker. Tesseract stays as the fallback: when the build has no models, when they fail to load, or when the worker dies or fails three reads in a row. The Android app's ML Kit is chosen in the same place (`ocrEngine.ts`), ahead of both; in the app without it, PaddleOCR reads from the models bundled in the APK.

How it reads (`paddle.ts`): the detector (2.4 MB) finds the words in the crop as slightly turned boxes; boxes on one line are merged and the recogniser (7.8 MB) reads the line in one run, straightened and scaled to 48 px high, with greedy CTC decoding. A whitelist (the collector line's uppercase set) masks the classes that may win, like Tesseract's. A title read keeps the line with the most text; a collector block keeps its lowest six lines, top to bottom. A line's direction comes from its longest words (a short word's is mostly noise). When the detector finds nothing, the crop is split into lines by rows of ink. Confidence is the mean probability of the kept characters, on Tesseract's 0 to 100 scale. Only the title close-up reads it (to decide whether to try another crop); the printing is settled by the catalog lookup and the title check, as before.

Serving: `web/scripts/paddle-models.mjs` pins the three files (recogniser, its dictionary, detector) to one commit of `monkt/paddleocr-onnx` on Hugging Face with their sizes and SHA-256 sums. The build (`copy-ocr.mjs`) downloads them once into `node_modules/.cache/yama-ocr` (or `YAMA_OCR_CACHE`), checks them, and copies them to `/ocr/paddle-<checksums>/` with a NOTICE, so a new model gets a new address (served immutable; a missing path under `/ocr/` is a 404, never the app page). A build fails if they don't match. If they can't be fetched, a CI build fails (so a pull request finds out), while the deploy's Docker build and `npm run dev` go on without them, with a warning in the build log, and that build's scanner reads with Tesseract: a Hugging Face outage doesn't block a release. Each deploy's build fetches them again (10.3 MB; the Docker build has no cache for them). They are fetched only when the scanner first reads text, and the service worker keeps them like the rest of `/ocr/`. The worker shares the art recognizer's ONNX Runtime WASM file.

Measured the same way as "Measured results" below (Node 26, one WASM thread, the same 26 cards; Tesseract rerun on this machine for the times) [ran]:

| | Tesseract.js 7 | PP-OCRv5 rec + PP-OCRv3 det |
|---|---|---|
| Whole card, refined quad: card right / printing right / confident and wrong | 82% / 73% / 0 | **97% / 84% / 0** |
| Whole card, guide quad | 78% / 63% / 1 | 95% / 75% / 0 |
| Whole card, exact corners | 85% / 77% / 1 | 99% / 93% / 0 |
| Rough captures (dark, glare, blur, black mat), refined | 38% / 15% | 88% / 60% |
| 1993-2003 frames, card right | 33% | 100% |
| Close-ups: printings right / wrong / left to pick, of 26 | 19 / 0 / 7 | **20 / 0 / 6** (every card that prints a set code) |
| Close-ups: titles right, of 26 | 20 | **25** (the miss is the sideways battle) |
| Whole-card scan, refined, median / p90 ms (Node) | 258 / 424 | 288 / 578 |
| One collector block read, median / p90 ms (desktop Chrome, worker) | 70 / 143 | 150 / 220 |
| One title read, median / p90 ms (desktop Chrome) | 21 / 30 | 54 / 75 |
| Model load in Chrome, files cached | 115 ms | 280 to 520 ms |
| Download | 2.95 MB model + 2.9 MB WASM core | 10.3 MB models (ONNX Runtime WASM already loaded for the art recognizer) |

What it changed: it reads the bullet, the artist's name and small type almost exactly ("C 0145 WOC•EN DAN SCOTT"), so the set code and number come through in the rough, far and skewed captures where Tesseract read noise. Against Tesseract on the refined quad it gained 20 cards and lost one (the handheld battle, whose title runs sideways). Wrong answers stayed below the 0.8 confidence line in every run. Reading titles through the detector too (rather than the row split) took the whole-card score from 95% to 97% and upside-down scans from 88% to 100%, for about 45 ms more per frame. In a title close-up, a read now has to reach confidence 50 before the scanner stops trying crops: a text band found on the card's frame read as three unsure letters (38) and hid the real title (93 and up); Tesseract's close-up titles are unchanged by this (20 of 26).

What it costs: a collector read takes about twice Tesseract's time on one WASM thread, nearly all of it the recogniser (about 50 ms per line; the collector crop holds two or three lines, the artist's name included) and 43 ms for the detector. On a phone that is likely 300 to 600 ms per collector read [inferred: the 2 to 4 times laptop rule above]. The first text read in a scanner session also waits for the 10.3 MB of models (at most 90 s, then Tesseract); on a slow connection that is a long first wait, once per device, since the service worker keeps them. Reading with Tesseract while the models download would hide it, at the cost of downloading both. Ways to cut the read time, not yet tried: int8 quantisation of the recogniser (smaller and faster in WASM, needs its own accuracy run), WebGPU where the browser has it, and cropping the artist's name off the collector line before reading.

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
      ─▶ embed (the graph warps the card itself) ─▶ search: top 5 of 52,350 illustrations
      ─▶ lock at score ≥ 0.82, or ≥ 0.62 on two agreeing frames
      ─▶ GET /api/scan/printings?art=<illustration id>: the printings that share the art
      ─▶ one English printing: done. Several: OCR the collector line (full-resolution crop at the quad)
         and pick among them (pickPrinting). Still unsure: the person picks from thumbnails.
art score < 0.5 for 3 frames ─▶ the OCR pipeline below, at the detector's quad (a quarter turn per try, for battles)
```

- **Bundle:** `scanner-bundle-gallery-20261106T183001884398Z` (since 2026-11-15; before that `retrain-20261026T052522727512Z`) from `cfbender/manavault` releases, pinned with SHA-256 sums in `server/src/scan.rs`. The server downloads it once into `data/scan-bundle/<version>/` (on startup when imports run, or on the first `GET /api/scan/bundle`), drops the 126 MB `printings.json` it doesn't need, and turns the 18 MB `arts.json` into a 6 MB column form (3.2 MB gzipped). It serves the files at `/scan-bundle/<version>/` as immutable. Phones never fetch from GitHub. Once a new version is ready, the server deletes the folders of earlier versions (`remove_other_bundles`).
- **On the phone:** the first scanner open downloads about 39 MB over the wire (detector 12.6 MB, search 14.2 MB, embed 5.1 MB, artwork index 3.2 MB, ONNX Runtime WASM 3.9 MB, gzipped where it helps), with a progress line, into the Cache API (`yama-scan-v1`, kept by `sw.js`). Later opens load from the cache. The OCR models (10.3 MB, "Browser OCR: PP-OCRv5") are loaded only when a collector line has to be read.
- **Printings that share art:** `printings.illustration_id` and `back_illustration_id` (migration 0036, filled by the `default_cards` import, importer version 3, so a running server re-imports on its next pass). Until a printing has illustration data, the endpoint returns every printing of the card (`same_art: false`); the collector line then has to read the set code exactly to settle it.
- **Cards the index doesn't know:** a bundle doesn't know cards printed after it (the pinned one is from 6 November), and the bundle leaves out battles and art series. These score below 0.6 (wrong matches scored at most 0.58 in the eval), so the scanner reads their text instead. Move to a newer bundle by changing the tag, sizes and sums in `scan.rs`, checking the search graph's inputs against `recognizer.ts`, and rerunning the recognizer eval. ManaVault publishes a bundle every week or two.

### Bundle gallery-20261106 (2026-11-15)

Bryan was about to scan the Star Trek Commander decks, released 13 November after the pinned 26 October bundle, so they would have fallen back to reading text. `gallery-20261106T183001884398Z` was the newest published bundle (`gh release list -R cfbender/manavault`, 15 Nov). What changed [ran]:

- **Same models, larger gallery.** `detector.onnx` and `embed.onnx` are byte-identical (same SHA-256); the manifest names the same recogniser checkpoint (`retrain-20261026…`) and detector. 52,350 artworks, up from 51,843: 291 `trc`, 132 `trk`, 26 `ttrk`, 25 `sds`, 22 `sld`, 7 `ttrc` and a few promos are new. Checked against Scryfall (`e:trc` and `e:trk`, with extras and variations): all 556 Star Trek Commander cards' artworks are in it (67 were in the old bundle) and all 586 Star Trek ones (419 before). The art series (`atrk`, `atrc`) aren't, as usual.
- **The search graph takes a mask.** The manifest says `search_mask: true`: `search.onnx` now needs a second input, `mask` (float32, one value per artwork in `arts.json` order; above 0 competes, 0 scores −3), and fails without it ("input 'mask' is missing"). oracle's `docs/pipeline.md`, "Search mask": ones reproduce the unmasked graph exactly. `recognizer.ts` now feeds ones when the session's `inputNames` include `mask`, and only `embeddings` otherwise (unit test in `printings.test.ts`). The graph's gallery, frames and penalties initializers are unchanged, so `readGallery` (`gallery.ts`) still reads them: on random embeddings its top 5 and scores matched the graph's to six decimals, about 18 ms for the whole graph on an M3 Pro. The mask could replace the JavaScript pool search for the set lock later; it isn't used for that yet.
- **Eval, before and after** [ran, 2026-11-15, M3 Pro, one WASM thread]. `recognizer.test.ts` needs `data/yama.db` only to find fixture images, and no copy was on this machine, so a throwaway driver (not committed) ran the same harness (`renderScene`, the six free-hand variants plus "steady" and "far" with the guide, same seeds) on both bundles. It took image URLs from Scryfall instead of the database and added 26 cards whose art is new in this bundle: 14 `trc`, 6 `trk`, 4 `sds` and 2 `sld`, the only new sets released between the two bundles.

  | Bundle | Cards | Scans | Card found | Right card | Wrong, scoring ≥ 0.6 | Wrong, scoring ≥ 0.8 | Median ms |
  |---|---|---|---|---|---|---|---|
  | retrain-20261026 | the 26 eval cards | 208 | 98.6% | 95.7% | 0 | 0 | 162 |
  | gallery-20261106 | the 26 eval cards | 208 | 98.6% | 95.7% | 0 | 0 | 164 |
  | retrain-20261026 | 26 new-set cards | 208 | 100% | 0% | 103 | 0 | 161 |
  | gallery-20261106 | 26 new-set cards | 208 | 100% | 99.5% | 1 | 0 | 165 |

  The eval cards' misses are the same in both: the battle (Invasion of Tolvada, as before) and two "no card" frames on the full-art Forest. With the old bundle the new cards weren't only unknown: half their scans scored 0.6 to 0.65 against the wrong card (Funeral Room, a Swamp, Riptide Survivor), above the "wrong answers scored at most 0.58" this page relied on, so two agreeing frames at 0.62 could lock a wrong card. With the new bundle the one miss is Scotty, Miracle Worker under the rough variant, taken for Raiders' Karve at 0.675.
- **Licence:** the release notes are unchanged in kind ("exported by cardid"), no licence file in the bundle, and both repositories are still MPL-2.0, so the notices below stand.
- **Deploy:** the server downloads the new files on its first start (about 50 MB from GitHub) and serves them under the new version's path. A phone running the previous web build would load the new graph with the old glue, fail at the warm-up, and scan by text until the app reloads; the shell is fetched from the network first and the Android app takes the web update on its own, so that lasts until the next reload. The new build reuses the files that attempt cached. The service worker never serves `/scan-bundle/` or `/api/` from its caches, and the art worker drops other versions' files from `yama-scan-v1`, so nobody gets a stale bundle. Everyone downloads about 35 MB again on their next scan.

### The bundle's layout, for extending the gallery ourselves (2026-11-15)

Read from the pinned bundle's graphs [ran: protobuf dump of both bundles' `.onnx` files] and from oracle at `b681392` (`docs/pipeline.md`, `cardid/graphs.py`, `degrade.py`, `data.py`, `detect.py`, `index.py`, `model.py`) [read]. For a later slice where Yama embeds artworks the bundle lacks and serves a supplement the worker merges.

- **Versions.** All three graphs are ONNX IR 8, opset 17 (`ai.onnx` only), exported by PyTorch, in both the 26 Oct and the 6 Nov bundle. A `gallery-…` release re-embeds the art with the published checkpoints and re-exports (oracle's `new-set`, `retrain --gallery-only`); a `retrain-…` release trains new weights. This one is a gallery release: `embed.onnx` and `detector.onnx` are byte-identical to the 26 Oct pin, and the manifest names the same recogniser checkpoint (`retrain-20261026T052522727512Z/last.pt`, sha256 `eb655846…`). Vectors we compute with this `embed.onnx` are therefore comparable with every row of this gallery, and stay so until a `retrain-…` bundle.
- **`embed.onnx`, the embedding graph** (679 nodes, 109 initializers). Inputs `scene` (uint8 H × W × 4 RGBA, any size) and `quad` (float32 4 × 2, the card's corners in printed order, scene pixels). Output `embeddings`, float32 F × 128, L2-normalised, one row per frame cut in `manifest.constants.frame_names` order (F = 17 now). Inside: a projective warp of the card to 250 × 350 (`GridSample`, bilinear, rounded to whole values), then for each frame its art box cut from that card (boxes in oracle's `detect.FRAMES`: modern is x 0.08 to 0.92 from y 0.115, at the art's aspect), turned upright for the two-part frames, resized to 128 × 128 (bilinear, aspect squashed), divided by 255, ImageNet-normalised (mean 0.485, 0.456, 0.406; std 0.229, 0.224, 0.225), then MobileNetV3-Small, average pool, a 576 → 128 linear layer and L2 normalisation.
- **How a gallery row is made** (oracle `index.ArtIndex`, `degrade.clean_view`): Scryfall's `art_crop` JPEG, RGB, resized straight to 128 × 128 with OpenCV `INTER_AREA` (aspect squashed, no padding), the same /255 and ImageNet normalisation, the same MobileNet and head. So the gallery side is the embedder alone on the whole art crop; the query side is the warp and cut in front of it. To embed an art crop with the published graph, either cut out the embedder subgraph (from the normalised 1 × 3 × 128 × 128 tensor to `embeddings`; a modified MPL file, whose source we'd then publish) or feed `embed.onnx` a synthetic card: a 250 × 350 scene with the crop resized into the frame's box and the quad at the scene's corners, taking the row of the art's frame. The second goes through bilinear resampling where oracle uses `INTER_AREA`, so it would differ slightly; measure either way by re-embedding a few hundred arts the bundle already has and comparing with their gallery rows (cosine near 1 expected).
- **`arts.json`, the gallery index.** A JSON array in gallery order (row i is gallery row i): `id` (Scryfall ID of a representative printing; `<id>-1` for face 1), `name`, `set`, `collector_number`, `layout`, `face`, `lang`, `illustration_id`, `url` (Scryfall `art_crop`), `frame` (one of `frame_names`) and `printing_count`. One row per distinct illustration (two for transform and modal DFCs, one per half for split, flip and Room cards); reprints share it. Our server keeps `id, name, set, number, illustration_id, layout, printings` as `arts.slim.json` (`slim_arts` in `scan.rs`). `printings.json` (126 MB, representative ID → sibling printings) we don't use; `/api/scan/printings` answers from our own database by `illustration_id`.
- **`search.onnx`, the search graph** (11 nodes; 15 with the mask). Initializers `gallery` (float16 N × 128, the gallery vectors), `frames` (int64 N × 1, each row's index into `frame_names`) and `penalties` (float32 N: 0.02 for the rare frames tall, token_tall, emblem, right, left and the two-part halves, plus each row's hub penalty, at most 0.1). Inputs `embeddings` (F × 128, `embed.onnx`'s output) and, since this bundle, `mask` (float32 N). Computes `score_i = gallery_i · embeddings[frames_i] − penalties_i`, masked rows set to −3, then top 5: outputs `indices` (int64) and `scores` (float32).
- **How `gallery.ts` reads it.** `readGallery` walks the ONNX protobuf by hand (ModelProto field 7 is the graph, GraphProto field 5 the initializers; a TensorProto's dims are field 1, data type 2, name 8, raw data 9), finds the three initializers by name, checks their types (float16, int64, float32) and lengths, and scores any subset of rows with the same formula in JavaScript (a half-to-float lookup table). That is how the set lock searches only its sets' artworks. It reads this bundle unchanged: on random embeddings its top 5 matched the graph's to six decimals.
- **Adding rows from a supplement: yes, alongside the graph, not inside it.** N is baked into the graph (the `gallery` initializer and the mask's shape), so new rows can't go into `search.onnx` without re-exporting it. But a supplement file with the same three arrays (vectors as f16, frame index, penalty) plus arts rows can be scored by the code `gallery.ts` already has, against the same `embeddings` the worker already computes, and merged with the graph's top 5 by score, its rows numbered from N up so `arts[index]` works. A few thousand rows cost well under a millisecond. Things to settle: the frame of each new art comes from its crop's aspect and layout (oracle's `frame_of`: below 0.6 left or right, below 1.1 tall, below 1.3 old or token, below 1.44 modern, above that extended, with emblem and token_tall cases), and has to use the bundle's `frame_names` order; the penalty is the 0.02 rare-frame prior, but the hub penalty needs oracle's 3,000-card scan set, so supplement rows would go without it (about half the gallery pays a few thousandths; a few arts up to 0.1); skip any illustration the bundle already has; and version the supplement by bundle version plus its own hash, since rows embedded with one bundle's weights are meaningless with another's.
- **Re-arming:** after Add (or Not this), the same artwork isn't found again until the card leaves the view or another card shows, so one card is never added twice by accident. Copies (1 to 10) are chosen on the result.
- **Keep adding (Bryan, 2026-10-28):** a switch under the camera, remembered per device. A card the camera found whose printing the scanner proved (the only printing, or the collector line read with proof) is added at once, one copy, with a buzz and "Added …" on the camera, and scanning goes on (`addsItself`). A typed name, a guessed or tapped printing still stops for Add. The same card isn't added twice until it has clearly left the view (`hold.ts`: four frames in a row with no card or only a weak match, or another card matched), so a second copy needs the first moved out of frame; one missed detection doesn't re-arm it. A card found by its text (no art match) is held by name the same way (`hold.ts`): until the detector sees no card, or another card is read twice since the held one was last read (once if near-certain). In text-only mode (no detector) four empty reads in a row, with the card unseen for 3 s, also end it; reads alternate orientations, so empty reads alone aren't proof. One misread doesn't free it, the title close-up doesn't start while it's held, and a photo skips the hold.
- **Fixing what was added:** "Added N: review" opens this session's cards, newest first, with copies, finish, Change printing and Remove. Adds merge into rows the person may already own, so a fix (`scanner/session.ts`) finds the row the add went into (Near Mint, English, same box) and takes back only this session's copies, then adds them again the new way; copies owned before are never touched. Copies of one printing are interchangeable, so the session also remembers what its own writes left in each row (`noteWrite`); if a row holds fewer when a fix is made (some taken out on another page or device), the fix is refused and points to the Collection page rather than risk taking an older copy. The session's writes run one at a time, each followed by its count lookup (three tries), and a fix's lookup, check and write run in the same queue, so overlapping saves (Keep adding the same printing twice quickly) can't muddle the counts; a fix is refused if the count couldn't be had. A row whose count was lost (lookups failed, or a retry the server reports as already applied) stays unchecked for the rest of the session, so fixes to it are refused; a later count could already miss copies taken out meanwhile. Known limit: the check and the fix are separate requests, so copies taken out on another device in the moment between them aren't caught; closing that needs a conditional op on the server, which offline-queued ops (applied later, by design) can't carry. The Collection page's own edits have the same window. The camera pauses while the list is open. Every write stays on its entry until the server confirms it, and the entry takes no other change meanwhile, from before the fix looks up its row (closing the list doesn't unlock it); a failed or unanswered write is only sent again unchanged (same op ids, applied once), so a lost reply can't double a fix. Keep adding says "Added" only after the save; a failed one stays in the list to try again.
- **Typing instead:** "Or type the name" opens the same printing picker.
- **Close-up step (Bryan's idea, 2026-10-28):** a whole card in view gives the collector line only about 1 to 2% of the frame's height, so when the first read can't settle the printing, step 2 starts by itself: a wide box replaces the card guide and asks for the phone close to the bottom-left corner. Each frame, just that box is read at full camera resolution (scaled to 200 px tall) and matched against the printings that share the art. A read of both set code and number settles it at once; set code or number alone needs the same answer twice. The picker stays below, so tapping is always an option. A printing tapped among several wasn't read from the card, so Add first asked to check the set code and number in the corner (Bryan, 2026-10-28): "Add anyway", or read it up close, which replaced the pick when it settled. Superseded 2026-11-15: tapping a printing files it ("Tap to file", above). Whenever the next step is a tap rather than the camera (picking a printing without a live camera), the camera's status chip turns white and says so, the phone buzzes, and the panel scrolls to it. For cards whose art isn't known, after two failed text reads (or with "Read the name up close") the scanner asks for the title the same way, then goes on to the printing.
- **Close-ups are a switch (Bryan, 2026-10-31):** "Close-ups" under the camera, on by default, remembered per device (`yama.scan.closeups`, shared by the collection and deck scans; `ScannerView`'s `closeups` prop). Bryan likes the two-step scan for handheld use, but a camera that stays put (a stand, or a feeder that drops cards under it) can't be moved to the corner. With it off, the scanner is one-step again: it reads the collector line from the whole-card view (since 2026-11-15, frame after frame while the card is held; "Hold and read" above), and if that doesn't settle the printing, it asks for a tap in the picker; an unknown card's name keeps being read from the whole card. Neither close-up starts by itself, but the "up close" buttons still start one. Turning it off ends a close-up in progress; the switch stays shown during both close-ups. Keep adding behaves the same either way: only a printing the scanner proved is added without a tap. A native app would do this differently.
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

`OcrEngine` and `ScanCatalog` are injected: `createScannerOcr()` (`ocrEngine.ts`: ML Kit in the Android app, PaddleOCR in the browser, Tesseract as the fallback) and `createServerCatalog()` for the app, `eval/dbCatalog.ts` (read-only SQLite) for tests.

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
| `ocrEngine.ts` | `createScannerOcr`: which OCR engine reads text (ML Kit, PaddleOCR, Tesseract), and the fallback to Tesseract |
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
