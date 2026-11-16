# Scanner design pass: what just happened first, options out of the way

**Status:** In progress, 16 Nov 2026. Built on branch `design/scanner-receipt` (4 commits on
main `48fd697`); reviewed by Fable 5.2 (code and design); **not yet** reviewed by Codex, pushed,
PR'd, merged or tried on a real phone.

**Asked for:** Bryan, 16 Nov 2026: "We're in desperate need of a fixup of the scanning
interface … It really needs a design pass for usability, getting stuff out of the way, and making
sure it's clear what's happening to the user. I think the options kind of pop up a little too
much in the user's face, as opposed to what happened or recently happened." After the first
round: "a teeny bit more compact … too busy … keep as much information as we can just hidden."
He liked "+1 copy", asked where "Scan anyway" went (it is +1 copy, now on the camera), and asked
whether lining the card up with the frame is needed (it isn't with art recognition: see below).
Then: "let's get an adversarial review from a Codex 6.1 Max, maybe even a Fable 5.2."

## Picking it up

The branch is in the primary checkout's refs (it was never pushed). Follow AGENTS.md: work in
a worktree, never in `~/Developer/yama`.

```sh
cd ~/Developer/yama && git fetch origin
git worktree add ~/Developer/.worktrees/yama/scanner-receipt design/scanner-receipt
cd ~/Developer/.worktrees/yama/scanner-receipt
git rebase origin/main          # scanner files had no conflicts as of 48fd697
npm ci
```

Then the usual Default completion: Codex review (Bryan asked for Codex 6.1 Max, adversarial),
fix findings, `scripts/local-ci.sh` (web only: no Rust is touched), draft PR → ready, merge, deploy,
check the live scanner. Check `python3 scripts/ci/train_lease.py status` first (release trains).

**Another agent was working on scanner feedback at the same time** (in a T3 worktree). Expect
conflicts in `web/src/scanner/ScannerView.tsx` and `scanner.css`. Land one, rebase the other.

To see it without a camera or server: `npm run dev -w web`, open
`/src/scanner/dev.html?demo=1`. Typing a name needs `/api/cards/autocomplete` and
`/api/scan/printings`; mock them (Playwright `route`) or run `npm run local`. In a sandbox without
the art bundle the scanner falls back to text mode, which draws the full frame; art mode draws
corners only.

## The idea

The camera says what the scanner is doing **now**; the strip of added cards says what it **did**;
the sheet asks only for what it **needs**, and everything lesser is one tap away.

## What's built (by commit)

1. **Receipt** (`bdae572`). The strip's head names the card just added, with Undo beside it; events
   (Took out …, Couldn't …, Kept …) take its place briefly. The camera's chip no longer carries
   "Added … Undo / Wrong printing". Printings to pick are one row of small tiles to swipe (wrapping
   rows on a laptop). Lesser choices share one quiet row. "Scan only some sets" is under More until
   a lock is on; the lock pill shows only while one is. The set suggestion is one line with a "?".
   "What the scanner saw" shows only with Scanner diagnostics on. Landscape ≥900×600: camera on
   the left, strip and sheet in a right-hand column.
2. **Compact** (`88ba379`). +1 copy (Scan anyway) moves onto the camera chip while the card just
   added is still in view. Wrong printing beside Undo only when the scanner read the printing
   itself (a tapped one is fixed from the card's sheet). The camera says nothing while just waiting
   once the strip has cards. With art recognition the guide is four faint corners. Zoom is one
   button with the level; + and − open from it and fold away after 4 s. On a phone the strip
   steps aside while a card waits on you. How a card was found is behind a "?"; Wrong card, Wrong
   printing, Change printing and the close-up are under More beside Skip. Only the newest tile
   shows its Commander tag (every tile's label still has it).
3. **Review fixes** (`880f91b`, Fable 5.2 code review, all 10 findings): receipt actions only
   when the newest entry *is* `justAdded.card`; no empty More; name suggestions no longer
   clipped; a hidden sheet returns in the side-column layout; the side column needs 600 px of
   height (big phones on their side keep the phone layout) and clears the right safe area;
   treatment and language visible on printing tiles; full touch targets under `pointer: coarse`;
   an always-mounted status line in the strip announces adds and events; events wrap and show
   even while deciding; zoom changes announced; idle-chip check on shared constants.
4. **Design review** (`b992aaa`, Fable 5.2 design critique, the quick items): the camera says
   "✓ Added, $1.40" for ~1.2 s after each add, then "Still in view" or "3 added" with +1 copy;
   each printing tile shows its own price (plus treatment/language); "Tap your printing" said
   once (camera only); Undo sits right after the card's name, away from Review all; on a laptop
   the previous card's name dims while deciding; corners go white when a card is seen; the
   filing line is one left-aligned line with a chevron.

Files: `web/src/scanner/{ScannerView,ScanTray,camera}.tsx`, `scanner.css`, their tests,
`docs/features.md` (Scanner). All web tests, typecheck and build pass on `b992aaa` (cloud
sandbox, not `scripts/local-ci.sh`).

## Open decisions (Bryan)

1. **Look-alikes under the name.** When the scanner is unsure (`found.others` non-empty), show
   them as one row of quiet pills under the card's name, so Wrong card is one tap, not three
   (More → Wrong card → name). Mostly helps deck, box and swap checks. Nothing shown when sure.
2. **A camera that doesn't resize on a phone.** The camera changes height two or three times per
   card that needs a tap (strip hides, sheet grows, strip returns), so a held card moves on
   screen. Proposal: fixed camera share (~45dvh); the found sheet slides over the strip.
3. **Laptop as its own layout.** The strip as a vertical list down the right column (thumb, name,
   set and number, price; Undo on the newest row), and keyboard shortcuts behind one "?":
   1–9 pick a printing, Enter adds, Esc skips, Z undoes, + adds another copy.

## Known gaps

- Not tried on a real phone or with real art recognition; screenshots used Chrome's fake camera
  and placeholder art (Scryfall was unreachable from the sandbox).
- The text-mode fallback (no art bundle) still needs the frame: the text reader crops to it.
  Making that frame-free is reader work, not design.
- Laptop: with many printings, Skip and More can scroll below the fold in the right column.
- Phone landscape (e.g. 844×390) was already cramped on main; unchanged.
- From the design review, not done: pill styles could settle on two (outlined on black,
  filled on the sheet); the session total line could put "market, Nov 15, 1 unpriced" in the
  dim note only; Undo could fade over its last second.
