# Yama Night table

Yama's visual system: a near-black, neutral table, so commander art and the five mana colors carry all the color. White is the only accent. Bryan picked it on 19 Oct 2026; it replaced the felt-green playmat. The source of truth is the repo (`design/tokens.md`, `web/src/styles.css`); this system mirrors it for design work on Claude canvases.

## Content fundamentals

Write like Bryan: direct, plain and useful. Headings, labels and buttons do the work.

- **Sentence case everywhere.** No all-caps labels. No middle-dot meta strings ("Bracket 4 · 38 changes"); write a sentence or use separate lines.
- **Cut before you explain.** Delete copy that repeats a heading or a button. An empty state needs one sentence. No feature pitches, rhetorical questions or reassurance after every action.
- **Say the consequence where the decision is.** "Approve plan" sits beside "Nothing is bought until you mark it." Don't repeat it across the page.
- **Help is one native disclosure** with a specific label ("How brackets work"), never a hover-only tooltip.
- **Keep facts visible.** Errors, warnings, missing data, source dates, price sources and art credits stay beside what they qualify.
- **Never invent numbers.** A missing price says "No price", never $0. A price carries its source and date: "Mothership, $0.75, checked 28 Oct".
- **People never see internal words** like "promote", "planner", "note deck" or "tracked".

Examples: "Waiting for your OK", "Approve plan", "38 changes", "6 to buy, $5.00", "Proposed by Claude on 28 Oct from the commander review".

## Visual foundations

### Color

| Token | Use |
|---|---|
| `ground` #0b0c0e | Page background |
| `surface` #15171a | Cards, panels, sheets |
| `raised` #1e2125 | Inputs on surface, chips, secondary buttons |
| `line` #2a2e33 | Hairlines and outlines only |
| `text` #f2efe8 | Body text and the primary button |
| `dim` #a9adb3 | Secondary text (8:1 on ground) |
| `good` #8fd3a8 | Have it, ready, done |
| `warn` #f0b45a | Need it, waiting (outside games) |
| `bad` #f07a62 | Destructive, banned, warnings |

- White (`text`) is the only accent. There is no brand hue.
- Status color always comes with a word. A pill is status text on its own tint (`good-tint`, `warn-tint`, `bad-tint`), with no border.
- Mana colors (`mana-w` … `mana-c`) only ever mean whose: identity dots, pips, curve bars.
- In a game, `pick` (amber) means one thing: you can pick or play this. Seat colors sit beside a name or art, never alone.
- `--paper-faint` is retired: it failed 4.5:1. Use `dim` for text, `line` for decoration.

### Type

- **Display: Big Shoulders Display** 500/700/800 (Google Fonts) for page titles, deck names on art, section headings and big numbers.
- **Body: Atkinson Hyperlegible Next** 400/700 for everything else, tabular figures in tables.
- **Mono: Atkinson Hyperlegible Mono**, only in the card search box.
- Page title 48 px phone / 64 px laptop at 0.9 leading; hero deck title 56 px phone / 56-64 px laptop (96 px only for a phone-width poster); sections 24-36 px; body 16 px; meta 13-14 px; credits 10-12 px.

### Shape and space

- Radii: inputs 12, secondary buttons and menus 10, lists 16, panels and art tiles 20, sheets 24 (top only), the primary button, segmented controls and status pills 999 (pills), card images 4.75% / 3.4%.
- Spacing steps: 8, 12, 16, 24, 32. Page padding 16 px on phones, clamp(20px, 4vw, 56px) on laptops. Content max-width 1120 px.
- Touch targets at least 44 px on phones, the primary 48-56 px. On a laptop controls are 36 px and the primary 40 px (see Density below).

### Buttons and controls

- **Primary:** a `text` pill with `ground` text. One per view.
- **Secondary:** a `raised` button with a 10 px radius (`r-control`), or transparent with a 1 px `line` border. At most three beside the primary; the rest go in a More menu.
- **Quiet:** transparent text button that raises on hover, for "Skip" and "Undo".
- **Segmented:** a `surface` track with 3 px padding; the selected segment is a `text` pill with dark text. 36 px tall on a laptop.
- **Inputs:** `surface` on ground (or `ground` on surface), 1 px `line`; labels 14 px bold above.
- **Checkboxes and radios:** a fixed 20 px box beside their words.
- **Navigation:** laptop left rail 220-248 px (active item a `raised` pill); phone bottom tab bar 76 px with six tabs. Decks sections: Decks, Sharing, Swap cards, Plans.

### Density, actions and page structure (Bryan, 8 Nov 2026)

Bryan: the bubble buttons are "too big and too hard to use. Once you get a few of them, they start being terrible"; the expandable sections are "too hard to use"; it "performs very poorly on desktop"; things with "no padding" touching the thing before them; "so many expandable areas" that you scroll all around.

1. **Two densities.** Phones and touch screens (`pointer: coarse`) keep 44 px targets. On a laptop (`pointer: fine`) controls are 36 px (`control-desktop`), the primary 40 px, row actions and toolbar icons 32 px, labels 14-15 px. Never a 44-56 px pill row on a laptop.
2. **Actions: one primary, up to three secondaries, then a menu.** A page's actions are one toolbar: the primary (a `text` pill), at most three secondary buttons (`r-control` 10 px radius, `raised` fill, icon plus label), then a More button that opens a **floating menu** (a popover on a laptop, a bottom sheet on a phone). A menu never expands inline and never pushes the page down. Menus hold at most about 7 items, grouped with a hairline, destructive last and in `bad`.
3. **Nothing touches.** Lay out with flex or grid `gap`, never margins that can collapse to 0. A row of actions sits at least `stack-gap` (16 px) below what's above it; sections are `section-gap` (32 px) apart; buttons inside a panel keep the panel's padding.
4. **Sections, not disclosures.** A page with more than three sections gets **section tabs**: a sticky strip under the header (3-5 tabs, counts beside the labels) that either switches between real subpages (Deck: Cards, Stats, Plan, History) or jumps between sections that all stay open. A disclosure is only for a method or a long list nobody needs by default, at most one per section, never for the main content, never nested.
5. **Compact headers on a laptop.** The art hero is about 200 px tall with a 56-64 px title; the 96 px hero title is for a phone-width poster moment, not a working page. Stat tiles sit on the hero's right.
6. **Selects.** A choice of two to five visible options is a segmented control (36 px on a laptop); six or more, or anything with search, is a picker menu with a search field.
7. **No micro copy** (Bryan, 8 Nov: "Stop putting so much micro copy everywhere ... that's a rule for the whole design philosophy"). No hint lines under options, fields, headings or buttons; no explanatory paragraphs. Labels, headings and buttons do the work. Anything more goes behind one small "?" button per section that opens a popover. Consequences of a destructive action still show at the moment of the action, in one short line.
8. **Phone mirrors laptop.** Same tabs, sections and order on both; only density and layout change (the side column drops below, More becomes a bottom sheet).
9. **Art first.** Use real commander art and card pictures from Scryfall wherever a deck or card is named; credit the artist.

### The art panel (the signature pattern)

1. The commander's Scryfall `art_crop`, loaded at runtime, never stored, `object-fit: cover`.
2. **Never filter, blur, desaturate or fade a card image.** All darkening is an overlay on top.
3. Washes by where text sits: bottom text `linear-gradient(180deg, rgb(11 12 14 / .15) 30%, var(--ground) 100%)`; left text `linear-gradient(90deg, rgb(11 12 14 / .88), .55 at 60%, .2)`; a centered number gets a radial wash.
4. Small text on art sits on `art-chip`; big numbers sit on the wash with `art-shadow`.
5. **Credit every art crop** in the same view: "Art: Name, © Wizards of the Coast" at 10-12 px.
6. No art yet: a `raised` block. Empty slot: a 2 px dashed `line` border.
7. Wide headers keep the whole composition (`object-fit: contain`, right-aligned, max 626 px).
8. Gradients only as washes over art. No decorative gradients anywhere else.

### Prices and evidence

Every price names its source and date. Totals add only known prices and count the rest as "without a listed price". Simulation numbers name the engine, games, AI level and date.

## Iconography

Inline stroke icons, 2 px stroke, round caps and joins, 20-24 px, `currentColor` (the Lucide shape language). No emoji. Mana symbols and Wizards marks are never drawn or shipped; card images load from Scryfall at runtime.

## Logo

The wordmark is YAMA in caps (an acronym: Yet Another Magic App); its two A's have no crossbars and rise above the cap line as two peaks. The icon is those two peaks: near in `text`, far in `dim`, on `ground`. See the Logos group. Wherever the name appears in full, keep "Unofficial fan software, not affiliated with or endorsed by Wizards of the Coast."

## Using it on a canvas

Load the two Google families in `<helmet>`:
`https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@500;700;800&family=Atkinson+Hyperlegible+Next:wght@400;700&display=swap`.
Use the tokens as CSS variables (`var(--ground)` …) or their hex values. There is no component bundle: the components here are markup patterns with guidelines; copy their markup.
