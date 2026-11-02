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
  | Hero deck title | 56 px | 96 px |
  | Section heading | 24–36 px | 24–36 px |
  | Big numbers | 28–56 px | 28–56 px |
  | Life total, 4-player panel | 132 px | |
  | Life total, guest phone | 220 px | |

- Body text is 16 px. Captions and meta are 13–14 px, credits 10–12 px.
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
  | Buttons, chips, segmented controls | 999 px (pills) |
  | Card images | 4.75% / 3.4% |
  | Battlefield tiles | 8–12 px |

- **Spacing:** gaps of 8 / 12 / 16 / 24 / 32 px. Page padding is 16 px on phones and clamp(20px, 4vw, 56px) on laptops. Content max-width is 1120 px.
- **Touch targets:** at least 44 px. Primary buttons are 48–56 px.
- **Chevrons:** single-select controls reserve 44 px at the end, with a 16 px arrow inset
  14 px from the edge. Disclosures leave 12 px between their chevron and label. Keep their
  full target in the layout; negative margins must not overlap adjacent controls.

## Copy and help

Use labels and actions that explain themselves. Remove redundant introductions and repeated
instructions. Put optional methods, definitions, shortcuts and extended explanations in a
native, collapsed disclosure with a specific label. Disclosures must work on touch and keyboard;
do not rely on a hover-only tooltip. Group related guidance instead of adding a help row for
every field. Keep errors, active warnings, missing data, source dates, price sources and art
credits visible beside the relevant content.

## Buttons and controls

- **Primary:** a `--text` pill with `--ground` text. One per view.
- **Secondary:** a `--raised` pill, or a transparent pill with a 1px `--line` border.
- **Segmented control:** a `--surface` track with 3 px padding. The selected segment is a `--text` pill with dark text; the others are `--dim` text.
- **Inputs:** `--surface` on ground, or `--ground` on surface, with a 1px `--line` border. Labels are 13–14 px bold, above the field.
- **Navigation:**
  - Laptop: a left rail of 220–248 px. The active item is a `--raised` pill. At the bottom is your commander-art avatar with the sync status under it.
  - Phone: a bottom tab bar, 76 px, with six tabs. The active tab is `--text`, the others `--dim`.
  - The Decks tab has a segmented control at the top: Decks | Plans | Lab.

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

- **Prices:** every price carries its date and source, e.g. "TCGplayer market via Scryfall, Oct 19". A missing price says "No price", never $0.
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
