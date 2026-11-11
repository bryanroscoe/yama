# Night table: Yama's visual system

Bryan picked this direction on 19 Oct 2026. It replaces the felt-green playmat look. The artboards that show it are on the design canvas (https://claude.ai/artifact/A54Pqc1rPe5U8c4ipARc1q, page "Night table"), and their `.dc.html` sources are mirrored next to this file.

The idea: a near-black, neutral table, so the commander art and the mana colors carry all the color. White is the only accent. Mana colors still only mean "whose".

## Color

```css
:root {
  --ground: #0b0c0e;   /* page background; replaces --felt */
  --surface: #15171a;  /* cards, panels, sheets; replaces --felt-2 */
  --raised: #1e2125;   /* inputs on surface, chips, secondary buttons; replaces --felt-3 */
  --line: #2a2e33;     /* hairlines and outlines */
  --text: #f2efe8;     /* body text, primary buttons (dark text on it); replaces --paper */
  --dim: #a9adb3;      /* secondary text; replaces --paper-dim. 8:1 on ground, 6:1 on raised */
  --good: #8fd3a8;     /* have it, legal, ready, connected; in a game, a result that's good for you */
  --pick: #f0b45a;     /* in a game: you can pick or play this. Never used for anything else on the board */
  --warn: #f0b45a;     /* outside games only: need it, waiting, uploads pending, 25% baselines */
  --bad: #f07a62;      /* destructive actions, banned; in a game, every warning */

  /* Phase stop ladder: shape and fill tell the kinds apart, not hue */
  --stop-mine: #f2efe8; /* filled dot */
  --stop-opp: #a9adb3;  /* outlined square */

  /* Seats, by turn order starting with you. You are always seat 1 */
  --seat-1: #408abf;   /* you: blue */
  --seat-2: #b55af6;   /* violet */
  --seat-3: #e8bae4;   /* orchid */
  --seat-4: #757a8a;   /* slate */
  --seat-5: #34b4f4;   /* sky */
  --seat-6: #f434c4;   /* magenta */
}
```

- **Amber in a game.** On the online board `--pick` means one thing: you can pick or play this. Rings on legal targets, on cards you can play, on sources you can tap. A thing you've picked turns white (`--text` ring) with a number badge when order or count matters. A preview ("will tap"), a status ("survives") or a tag ("You") is never amber.
- **Warnings in a game** use `--bad` with a word and an icon ("Lethal", "21 commander damage"). Green reports a good result for you ("Dies" on an attacker you block); it never means "you can play this".
- **Seat colours** were picked by simulating protanopia, deuteranopia and tritanopia (Machado 2009). Seats 1 to 4 stay at least ΔE 21 from each other and from `--bad`, `--good`, `--pick` and `--text` under every one; seats 5 and 6 drop that to ΔE 16. A seat colour always sits beside the player's name or art, never alone. It's used for the seat dot, that player's arrows, and the ring on their attacking creatures.

- `--paper-faint` is retired for text, because it fails 4.5:1. Use `--dim` for text and `--line` for decoration.
- The mana fills in `packages/core/src/mana.ts` stay as they are, for pips, identity dots and curve bars.
- Text on top of art is white (`#fff`), or `#d5d7db` for secondary lines.
- Status tints: `rgb(143 211 168 / 0.14)` behind `--good` text for legality pills.

## Type

- Display: **Big Shoulders** (the Google family with an optical-size axis; `@fontsource/big-shoulders-display` is the same design) at weights 500, 700 and 800. Use it for page titles, big numbers (life, prices, win rates), names on art, and section headings.
- Body: **Atkinson Hyperlegible Next** at 400 and 700, for everything else. Use tabular figures for numbers in tables.
- Mono: **Atkinson Hyperlegible Mono**, only for the search box.
- Sizes:

  | Use | Phone | Laptop |
  |---|---|---|
  | Page title | 48 px / 0.9 | 64 px / 0.9 |
  | Hero deck title | 56 px | 56–64 px (rule 7 below) |
  | Section heading | 24–36 px | 24–36 px |
  | Big numbers | 28–56 px | 28–56 px |
  | Life total, 4-player panel | 132 px | |
  | Life total, guest phone | 220 px | |

- Body text is 16 px. Captions and meta are 13–14 px, credits 10–12 px.
- Every size is a step on one scale, as a token in `web/src/styles.css`:

  | px | 11 | 12 | 13 | 14 | 15 | 16 | 18 | 20 | 22 | 24 | 28 | 32 | 36 | 40 | 44 |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | `--t-…` | `xs` | `12` | `sm` | `label` | `15` | `base` | `18` | `md` | `22` | `lg` | `28` | `xl` | `36` | `2xl` | `big` |

  `--t-title` and `--t-hero` are the page and deck titles, which grow on a laptop; `--t-button`
  is a button's label (15 px on a laptop, 16 px on touch). A stylesheet doesn't write a px or
  rem font size of its own (`conventions.test.ts` holds the few display numbers still to move).
- Keep sentence case everywhere: no all-caps labels and no middle-dot meta strings.

## Shape and spacing

- **Radii:**

  | Element | Radius |
  |---|---|
  | Inputs | 10–12 px |
  | Nav items | 12 px |
  | Lists and small cards | 14–16 px |
  | Panels and art tiles | 18–24 px |
  | Sheets | 24–26 px, top corners only |
  | Primary button, chips, segmented controls, status pills | 999 px (pills) |
  | Secondary buttons and menus | 10 px on a laptop; pills on phones |
  | Card images | 4.75% / 3.4% |
  | Battlefield tiles | 8–12 px |

- **Spacing:** gaps of 8 / 12 / 16 / 24 / 32 px. Page padding is 16 px on phones and clamp(20px, 4vw, 56px) on laptops. Content max-width is 1120 px.
- **Layers:** what sits over the page takes a named layer, lowest first: `--z-switch`,
  `--z-page-over`, `--z-bar` (tab bar, sticky tabs), `--z-status`, `--z-popover`, `--z-scrim`,
  `--z-sheet` (a dialog), `--z-overlay`, `--z-layer` (full-screen layers, menus opened from a
  dialog), `--z-banner`, `--z-frame`, `--z-picker`, `--z-question` (confirm and unsaved
  prompts) and `--z-preview` (the card preview that follows the pointer). Inside one component,
  a small number (-2 to 6) orders its own parts.
- **Touch targets:** at least 44 px on phones and touch screens; primary buttons 48–56 px there. On a laptop controls are 36 px, the primary 40 px (see Density, actions and page structure).
- **Chevrons:** single-select controls reserve 44 px at the end, with a 16 px arrow inset
  14 px from the edge. Disclosures leave 12 px between their chevron and label. Keep their
  full target in the layout; negative margins must not overlap adjacent controls.

## Copy and help

Write like Bryan: direct, plain and useful. Let headings, labels and buttons do the work.
Delete copy that repeats them. Empty states usually need one sentence. Skip feature pitches,
rhetorical questions and reassurance after every action. Say what an action saves or shares
where the person makes that decision; don't repeat it across the page.

Cut unnecessary explanations before moving anything into help. Put useful definitions and
shortcuts behind the section's one "?" button (rule 5 below); a long method may be one collapsed
disclosure with a specific label (rule 4). Either must work on touch and keyboard; never rely on a hover-only tooltip for necessary information. Keep errors, active
warnings, missing data, source dates, price sources and art credits visible beside their content.

## Buttons and controls

- **Primary:** a `--text` pill with `--ground` text. One per view.
- **Secondary:** a `--raised` button with 10 px corners on a laptop (a pill on phones), or transparent with a 1px `--line` border. At most three beside the primary; the rest go in a More menu.
- **Removing something:** `--bad` words on a secondary, an outline or a quiet button, saying what it removes. The last step of deleting for good, in a sheet of its own, is a `--bad` fill with `--ground` words.
- **Segmented control:** a `--surface` track with 3 px padding. The selected segment is a `--text` pill with dark text; the others are `--dim` text.
- **Inputs:** `--surface` on ground, or `--ground` on surface, with a 1px `--line` border. Labels are 13–14 px bold, above the field.
- **Navigation:**
  - Laptop: a left rail of 220–248 px. The active item is a `--raised` pill. At the bottom is your commander-art avatar with the sync status under it.
  - Phone: a bottom tab bar, 76 px, with seven tabs (Table, Play, Cards, Collection, Decks, Lab, Group). The active tab is `--text`, the others `--dim`.
  - The Decks tab has a segmented control at the top: Decks | Sharing | Swap cards | Plans.

## Density, actions and page structure (8 Nov 2026)

Bryan, 8 Nov 2026: the bubble buttons are "too big and too hard to use. Once you get a few of them,
they start being terrible"; the expandable sections are "too hard to use" and the site "performs
very poorly on desktop"; buttons with "no padding" touch the thing before them; "so many expandable
areas" you scroll all around; and "stop putting so much micro copy everywhere... that's a rule for
the whole design philosophy." The rules below answer those. They are drawn on the "Design language"
page of the redesign canvas (`design/screens/redesign-2026-11/Language.dc.html`).

1. **Two densities.** Phones and touch screens (`pointer: coarse`) keep 44 px targets. On a laptop
   (`pointer: fine`) controls are 36 px, the primary 40 px, row actions (Skip, Undo) 32 px, labels
   14–15 px. Never a row of 44–56 px pills on a laptop.
2. **One primary, up to three secondaries, then More.** A page's actions are one row. More opens a
   floating menu (a popover on a laptop, a bottom sheet on a phone): at most about seven items,
   grouped with hairlines, destructive last in `--bad`. A menu never expands inline or pushes the page
   down.
3. **Nothing touches.** Lay out with flex or grid `gap`, never margins that can collapse to 0. A row
   of actions sits at least 16 px below what's above it; sections are 32 px apart.
4. **Section tabs, not folds.** A page with more than three sections gets a sticky strip of 3–5
   tabs under its header (a deck: Cards, Stats, Plan, History; a plan: Changes, Questions, How it
   plays). Content under a tab is open. A disclosure is only for a method or a long list nobody needs
   by default, at most one per section, never nested.
5. **No micro copy.** No hint lines under options, fields, headings or buttons, and no explanatory
   paragraphs. Headings, labels and buttons do the work; anything more goes behind one small "?"
   button per section that opens a popover. A destructive action still says its consequence, in one
   short line, where it happens.
6. **Both cards on every change.** Wherever one card replaces another (a plan's changes, a swap bag,
   a list edit, history), show the card going in, an arrow, then the card it replaces, with the word
   "replaces". Tap either for the full card.
7. **Compact headers on a laptop.** The art hero is about 220 px tall with a 56–64 px title, stat
   tiles on its right.
8. **Selects.** Two to five visible choices are a 36 px segmented control; six or more, or anything
   searched, is a picker menu with a search field.
9. **Phone mirrors laptop.** The same tabs, sections and order; only density and layout change (the
   side column drops below, More becomes a sheet).

Tokens for these (in `design/system/tokens.json`): `control-desktop` 36px, `control-desktop-primary`
40px, `control-compact` 32px, `stack-gap` 16px, `section-gap` 32px, `r-control` 10px.

## The art panel (commander art behind players and decks)

This is the signature pattern. Use it for life-counter panels, deck headers, deck tiles, seat cards, opponent headers on the online board, binder tiles and the card page hero.

1. **The image:** the commander's Scryfall `art_crop`, loaded at runtime and never stored. `object-fit: cover`.
2. **Never filter the image.** Scryfall's guidelines rule out blur, desaturation, color shifts, stretching and opacity fades on card images. All darkening comes from an overlay *on top* of the image.
3. **The wash, chosen by where the text sits:**

   | Text position | Wash |
   |---|---|
   | Centered number (life panels) | `radial-gradient(70% 85% at 50% 50%, rgb(0 0 0 / .55), rgb(0 0 0 / .25) 70%, rgb(0 0 0 / .5))` |
   | Text at the bottom (deck headers, tiles) | `linear-gradient(180deg, rgb(11 12 14 / .15) 0–30%, …, var(--ground) or 0.9 at 100%)` |
   | Text on the left (opponent headers, seat rows) | `linear-gradient(90deg, rgb(11 12 14 / .88), .55 at 60%, .2)` |

4. **Small text over art** (names, badges, the commander damage pill) sits on a near-solid chip: `rgb(0 0 0 / .55–.6)` or `rgb(11 12 14 / .82)`. Big numbers sit straight on the wash, with `text-shadow: 0 2px 18px rgb(0 0 0 / .55)`.
5. **Credit:** every art crop carries "Art: Name, © Wizards of the Coast" somewhere in the same view, at 10–12 px. Alternatively, show the full card image in that view. On the online board, each battlefield's art credits sit in one line at the foot of that player's area ("Art: Craig Elliott, Bryan Sola, …"), and your portrait's artist is named under your life total.
6. **No art yet:** a `--raised` block. If the slot is empty (an open seat, no commander picked), use a 2px dashed `--line` border instead.
7. **Life counter:**
   - The art rotates with the panel, so it faces its player.
   - The active player gets `inset 0 0 0 3px var(--text)`.
   - The turn hub is a 60 px `--ground` circle with a 2 px `--text` ring.
   - Tap zones are the two halves of the panel, with faint − and + at the ends.
   - The running delta ("−3") sits in a dark pill beside the number.
   - Commander damage shows as a pill with the attacker's art as a 20 px circle.
   - A per-device toggle back to plain colors is fine, as the quickwins branch plans.

## Card surfaces

- **Card images:** full `normal` images in grids, stacks, hands and previews.
- **Visual stacks** overlap each card by `margin-top: -118%`, which leaves about 15% of the card showing.
- **Battlefield tiles** are square art crops, with a name bar on `rgb(11 12 14 / .82)` at the top (11–12 px bold) and P/T bottom-right as a `--text` box with dark text.
- **Tile highlights:**

  | State | Look |
  |---|---|
  | Has options (you can play or use it) | `0 0 0 2px var(--pick)` |
  | Picked for the current choice | `0 0 0 3px var(--text)`, plus a number badge when order or count matters |
  | Attacking | the attacker's seat-colour ring, plus a chip with the defender's art |
  | Commander | inner `--text` ring |
  | Stacked copies | ×N badge |
  | Tapped | rotated 90°, never dimmed with a filter |

## Prices and simulation numbers

- **Prices:** every price carries its date and source, e.g. "TCGplayer market via Scryfall, Oct 19". A missing price says "No price", never $0. Money, dates, counts and plurals come from one module (`design/system/shared-code.md`): dollars, "Oct 19, 2026", American spelling.
- **Simulation numbers** carry the engine, the number of games, the AI level and the date, and sit apart from real-game stats.
- **Win-rate bars** draw a `--warn` line at 25% for 4-player games, and fade players or commanders with too few games (under 10 for players, under 5 for commanders).

## Mapping from today's tokens

| Today | Night table |
|---|---|
| `--felt` | `--ground` |
| `--felt-2` | `--surface` |
| `--felt-3` | `--raised` |
| `--line` | `--line` (new value) |
| `--paper` | `--text` |
| `--paper-dim` | `--dim` |
| `--paper-faint` | `--dim` for text, `--line` for decoration |
| `--good` / `--warn` / `--bad` | same names, new values |
| `--radius: 6px` | see the radii above (pills for buttons) |

Also update `web/public/manifest.webmanifest` so its theme and background colors are `#0b0c0e`.

### Wide artwork and detailed evidence

Page headers preserve the whole art composition with `object-fit: contain`, in a right-aligned
window capped at 626 px. This applies to public precons/shared decks and private deck, Lab,
planner and sample-hand headers through `art-framing.css`. Do not enlarge a cover crop until
a character's face disappears. Compact cover-fitted tiles favour the top of the composition;
explicit focal-position overrides are still available. Preserve artist credit and use a separate
wash for legibility.

Result panels lead with a short label, value, sample count and source date. Keep confidence and
missing-data labels visible. Put interval explanations, rank ranges and limitations behind one
named disclosure; retain the interval graphic. Upgradeability shows the grade and assessed
coverage before package and commander disclosures. Evidence caveats stay with the evidence
they qualify, inside the same disclosure.
