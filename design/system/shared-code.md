# Shared code in the app

What the web app has one of, so a page doesn't grow its own. `web/src/conventions.test.ts` fails
when a page goes round one of these. Add a section here with each new shared piece.

## Formatting: `@yama/core` (`packages/core/src/format.ts`)

US only for now (Bryan, 11 Nov 2026): dollars, one date style, American spelling in interface
text. Nothing reads the browser's locale, so a value reads the same for everyone.

| Want | Use | Reads |
|---|---|---|
| A price | `usd(v)` | "$1,630.77", or "No price" when there isn't one (never $0) |
| A headline total | `usdWhole(v)` | "$1,631" |
| A missing price mid-sentence | `usd(v, "no price")` | the wording you give |
| A price's source and date | `priceSource(date)` | "TCGplayer market via Scryfall, Oct 19" |
| A number | `count(n)` | "1,234" |
| A number of things | `plural(n, "card")`, `plural(n, "proxy", "proxies")` | "1 card", "1,234 cards" |
| A share | `percent(0.443)`, `percent(0.443, 1)` | "44%", "44.3%" |
| A date | `fmtDate(v)` | "Oct 19, 2026" |
| A date whose year is plain | `shortDate(v)` or `fmtDate(v, { year: false })` | "Oct 19" |
| With the weekday | `fmtDate(v, { weekday: "short" })` | "Mon, Oct 19, 2026" |
| A time | `fmtTime(v)` | "9:30 PM" |
| A date and time | `fmtDateTime(v)` | "Oct 19, 2026, 9:30 PM" |
| A time today, a date and time otherwise | `fmtWhen(v)` | "9:30 PM", "Oct 20, 9:30 AM" |
| How long ago | `ago(v)` | "just now", "12 minutes ago", "yesterday", "5 days ago", then the date |
| A month | `fmtMonth(v)` | "October", "October 2025" |

- A date alone ("2026-10-19") is shown as written. A moment (a time with its zone) is shown on the
  reader's own calendar and clock; pass `{ utc: true }` for a day the server counts in UTC.
- A missing date is "" (`shortDate` gives null); text that isn't a date comes back as given.
- A missing price says "No price". A sentence about several cards can say "No prices" or count
  them ("3 without a price"); it never adds them as $0.
- Don't call `toLocaleString`, `toLocaleDateString`, `Intl.DateTimeFormat` or write `$${n.toFixed(2)}`
  in a page.

Not covered yet: the server-rendered public pages (`/precons`, `/commanders`) and the MCP tools
write their own dates in Rust.

## Components: `web/src/components/ui.tsx`

### Loading

A line that says something is on its way: `--dim` text with `role="status"`, so a screen reader
hears it once, politely. No spinner.

```tsx
<Loading />                                   // "Loading…"
<Loading>Loading the deck…</Loading>          // say what, when the page knows
<Loading small>Saving…</Loading>              // 13 px, beside a control
<Loading page>Loading the game…</Loading>     // a page with nothing else to draw yet
<Loading padded>Starting the scanner…</Loading> // outside any page padding
```

- One sentence ending in "…". Say what is loading rather than "Please wait".
- A button that is busy changes its own label ("Saving…"); that isn't a Loading line.
- A whole page that is still loading its code shows its stand-in (`StandIn.tsx`), not this.

### EmptyState

Nothing here yet: one sentence, and the way to add the first thing when there is one.

```tsx
<EmptyState>No playgroup yet.</EmptyState>
<EmptyState action={<Link className="button primary" to="/decks/import">Add a deck</Link>}>No decks yet.</EmptyState>
<EmptyState title="No plan for this deck" action={<Link to="/decks/plans">How plans work</Link>} />
<EmptyState variant="boxed">No changes yet.</EmptyState>
```

| Variant | Look | For |
|---|---|---|
| `plain` (default) | `--dim` text, 32 px above and below | a page or a section with nothing in it |
| `boxed` | a 2 px dashed `--line` outline, 16 px radius, centered | a slot where a list will appear |
| `panel` | a `--surface` card, 20 px radius, body text | the first thing on a page, with its actions |
| `compact` | a 13 px `--dim` line, no padding | inside a list or a small panel |

- One sentence (design/tokens.md, "Copy and help"). With a `title` or an `action` it becomes a
  stack: heading, sentence, actions, 12 px apart.
- Don't add a `something-empty` class; pick a variant. An empty card slot (a dashed outline where
  one card goes) and a picker's "no match" row aren't empty states.

### Segmented

A pill track for choosing one of two to five views or values of the same thing
(`components/Segmented/README.md` has the look). One ARIA model everywhere: a labelled
`role="group"` of buttons, the chosen one `aria-pressed="true"`. Never `radiogroup`, `tablist`,
`aria-checked` or `aria-selected` on a segmented control.

```tsx
<Segmented label="View" value={view} onChange={setView} options={[["pictures", "Pictures"], ["list", "List"]]} />
<Segmented labelledBy="own-label" value={ownership} onChange={setOwnership} options={OWNERSHIP} />  // { value, label }[]
<Segmented label="Bracket" value={bracket} disabled={saving} onChange={save}
  options={[{ value: null, label: "None", title: "Not declared" }, { value: 3, label: "3", title: "3, Upgraded" }]} />
<Segmented as="span" compact label="Sort" value={sort} onChange={setSort} options={SORTS} />
```

- Name the group: `label`, or `labelledBy` when its label is already on the page.
- A `title` on a segment is the full name of a short label (the tooltip and the accessible name).
- `value` may match no segment (a paused game's speed): nothing is pressed.
- `compact` is the smaller track for a toolbar (13 px labels). `as="span"` puts it inside a line.
- Six or more choices, or choices that are different tasks, aren't a segmented control
  (design/tokens.md, rule 8).
- Navigation between pages uses the same track with links and `aria-current="page"`
  (`components/DeckTabs.tsx`).

### Dialog

The app's one modal: a sheet from the bottom, or with `centered` a short question in the middle
of the screen. It lives in `components/Dialog.tsx` and is exported from `components/ui.tsx`.

```tsx
<Dialog title="Export deck" onClose={onClose}>…</Dialog>          // heading + Close, named by the heading
<Dialog label="Who goes first?" centered onClose={skip}>…</Dialog>  // draws its own first line
<Dialog label="Player" onClose={close}>
  <DialogHead onClose={back}>Edit {name}</DialogHead>              // a heading that changes inside one dialog
  …
</Dialog>
```

Every dialog:

- has a name: a `title` (drawn as an `h2` with Close at the end of its row) or a `label`. The
  types require one of them.
- has one dismiss control with one label, **Close**. Escape, the scrim and Close all call
  `onClose`. A question with its own answers (`DialogHead close={false}`) has no Close.
- moves focus in when it opens (to the heading, so no keyboard comes up on a phone; a field with
  `autoFocus` keeps it) and back to what opened it when it closes.
- keeps Tab inside, makes the rest of the page `inert`, and stops the page scrolling under it.
- answers Escape only when it is the top layer, and only after anything open inside it (a menu,
  a card preview, a search list) has had its turn. The page's own Escape shortcuts don't run.

`useModalLayer(ref, onClose, focusFirst?)` gives the same behaviour to a full-screen layer with
its own look (the card zoom, the full-screen picker, the scanner, the sample hand): spread what
it returns on the layer's root element. A floating menu or preview is not a layer: it takes
Escape in the capture phase, calls `preventDefault()` and `stopPropagation()`, and closes itself.

Don't write `role="dialog"`, a `.scrim`, a `.sheet-head` or a window `keydown` listener for
Escape in a page. Put a dialog's answers in a `.dialog-actions` row, the main one last.
