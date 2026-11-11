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
<EmptyState action={<ButtonLink variant="primary" to="/decks/import">Add a deck</ButtonLink>}>No decks yet.</EmptyState>
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
- opened from a `MoreMenu` action, gives focus back to the menu's button: the item that was
  pressed is gone by then (`returnFocusTo(from, to)` in `Dialog.tsx` names such a stand-in).
- keeps Tab inside, makes the rest of the page `inert`, and stops the page scrolling under it.
- answers Escape only when it is the top layer, and only after anything open inside it (a menu,
  a card preview, a search list) has had its turn. The page's own Escape shortcuts don't run.

`useModalLayer(ref, onClose, focusFirst?)` gives the same behaviour to a full-screen layer with
its own look (the card zoom, the full-screen picker, the scanner, the sample hand): spread what
it returns on the layer's root element. A floating menu or preview is not a layer: it takes
Escape in the capture phase, calls `preventDefault()` and `stopPropagation()`, and closes itself.

Don't write `role="dialog"`, a `.scrim`, a `.sheet-head` or a window `keydown` listener for
Escape in a page. Put a dialog's answers in a `.dialog-actions` row, the main one last.

### Questions: `ask` and `tell` (`components/confirm.tsx`)

The app's own "are you sure?" and "this went wrong", in place of the browser's `confirm()` and
`alert()`. `<ConfirmHost />`, mounted once at the root, draws them one at a time as a centered
alert dialog above every other layer.

```tsx
if (await ask({ title: "Delete this run?", body: "Its games and results go too.", confirm: "Delete run", danger: true })) remove.mutate();
await tell({ title: "Couldn't export", body: message });
```

- `title` is the question; `body` is the consequence, in one short line (it is read out with
  the question); `confirm` says what the button does, as a verb. Never "OK" for a question.
- `danger` for anything that deletes, discards, revokes or makes something public: the button
  is `--bad` and Cancel takes focus first, so Enter doesn't confirm it.
- Cancel, Escape, the scrim and the browser's Back all answer no.
- A question asked where the action is (an inline "Delete? / Keep") is fine; mark it
  `role="alert"` so it is announced. Don't call `confirm(` or `alert(`.

### ErrorText

What went wrong, in words, as an alert: `<ErrorText error={query.error} />`. `error` is whatever
was thrown, or the message itself; nothing is drawn for no error. `small` for a line beside a
control. With `retry`, a quiet "Try again" sits on the error's line: give it where asking again
can work.

- A page or panel whose query failed uses `LoadFailed` and `RefreshFailed`
  (`components/QueryError.tsx`): the first when there is nothing to show, the second when the
  last good data is still on screen and only its refresh failed.
- A sentence the page writes about its own state (a price that isn't a number, a list over a
  store's limit) is a plain `<p className="error">`, not an alert: it would be read out again
  every time it changes.

### CopyButton

`<CopyButton text={list} label="Copy the list" variant="outline" />` copies, reads "Copied" for
two seconds (aloud as well), goes back when the text changes, and when the browser refuses to
copy opens the text in a dialog to copy by hand. Don't call `navigator.clipboard.writeText` in a
page unless it does more than copy (the share sheet first, copy then open a site).

### Button and ButtonLink (`components/Button.tsx`)

Every button in the app is a `Button`; every link that looks like one is a `ButtonLink`
(`components/Button/README.md` has the looks and the two densities).

```tsx
<Button variant="primary" onClick={approve}>Approve plan</Button>   // the one thing the view is for
<Button onClick={print}>Print swap card</Button>                    // secondary: raised
<Button variant="outline" onClick={copy}>Copy list</Button>         // the other secondary: a hairline
<Button variant="quiet" size="small" onClick={skip}>Skip</Button>   // a row action
<Button variant="outline" danger onClick={remove}>Delete run</Button>   // --bad words: it removes something
<Button variant="destructive" type="submit">Delete deck</Button>    // the last step of deleting, in its own sheet
<Button type="submit" variant="primary">Save</Button>               // a form's submit says so
<ButtonLink variant="primary" to="/decks/import">Add a deck</ButtonLink>   // a page in the app
<ButtonLink href="/precons" variant="outline">Precon rankings</ButtonLink> // anywhere else
```

| Prop | Values | Reads |
|---|---|---|
| `variant` | `primary`, `secondary` (default), `outline`, `quiet`, `destructive` | the look |
| `size` | `small` | a row action: 32 px on a laptop, 44 px on a touch screen |
| `danger` | boolean | `--bad` words on a secondary, an outline or a quiet button |
| `type` | `button` (default), `submit`, `reset` | a `Button` never submits a form unless it says so |

- A label is a verb in sentence case that says what happens. A button that shows only an icon
  has an `aria-label`. Everything else a `<button>` takes (`disabled`, `aria-pressed`,
  `aria-expanded`, `ref`, `autoFocus`) passes through.
- One `primary` per view. A primary or a destructive button that is `disabled` reads as waiting
  (raised, dim words), not as a faded pill.
- `danger` marks any button that removes something ("Delete run", "Remove"), and the Yes of
  an `ask({ danger: true })` question. `destructive` is the last step of deleting for good, in
  a sheet of its own, often behind a typed confirmation (Delete deck, Delete account, an
  admin deleting a person). `danger` does nothing on a primary or a destructive button, and a
  quiet danger button stays words alone under the pointer. `ButtonLink` has no `destructive`.
- Something that happens here is a `Button`; going somewhere is a `ButtonLink` (`to` for a page
  in the app, `href` for a file, another site or a server-rendered page). Don't put an `onClick`
  that navigates on a `Button`, or `className="button"` on a link.
- A row, a tile or a card that is itself the control is still a `Button`: it passes its own
  `className` and keeps its look.
- `CopyButton`, `MoreMenu` and `ConnectButton` take the same `variant` (and `size`) and pass
  them to their button.
- Don't write `<button>` or `className="button"` in a page: `conventions.test.ts` fails on
  either, everywhere but the online board's `Board.tsx` and `Decide.tsx`.

### StatusPill and Tag (`components/StatusPill.tsx`)

The one way to show a state: a small pill of status text on its own tint
(`components/StatusPill/README.md`).

```tsx
<StatusPill tone="good">In the deck</StatusPill>
<StatusPill tone="warn">Waiting for your OK</StatusPill>
<StatusPill tone="bad">Commander: banned</StatusPill>
<StatusPill>Archived</StatusPill>                              // neutral: dim words, a hairline
<StatusPill tone={toneOf(status.tone)}>{status.pill}</StatusPill>  // a tone that arrives as a word
<StatusPill href="#changes">3 in, 3 out</StatusPill>           // a link to what it counts
<Tag>Foil</Tag>                                                // a label that names a kind, not a state
```

- The color always comes with a word that says what. It is plain text to a screen reader: no
  role and no live region (a status that changes while you watch is announced where it changes).
- One pill per thing, on one line: a few words, never a sentence (it doesn't wrap). A version,
  a date or a source is plain text, not a pill.
- `Tag` is never a link; a pill that goes somewhere is a `StatusPill` with `href`.
- On art (a deck's or a plan's header) a pill sits on a near-solid chip; the stylesheet does
  that for `.hero-status` and `.plans-hero-meta`.
- Don't write `className="tag"` or `className="pill"`; the old raised `.pill` look is gone.
- Not this: a count on a tab or a card (`deck-tab-badge`, `qty-badge`), a toggle chip in a
  filter row, and the online board's own tags.

### ActionBar (`components/ActionBar.tsx`)

A row of actions (`components/ActionBar/README.md`): the primary, at most three secondaries,
then `MoreMenu` for the rest. Buttons sit 8 px apart, wrap on a narrow screen and line up on
their middles.

```tsx
<ActionBar>
  <Button variant="primary" onClick={edit}>Edit list</Button>
  <Button onClick={share}>Share</Button>
  <MoreMenu>…</MoreMenu>
</ActionBar>
<ActionBar align="end">…</ActionBar>      // "end", "between" or "center"
<ActionBar as="span">…</ActionBar>        // inside a line
```

- It has no role: the buttons read as they are. Give it `role="group"` and an `aria-label`
  when the row needs a name of its own.
- The bar sits at least 16 px below what is above it; the page's own gap does that, not a
  margin on the bar.
- Don't add a `something-actions` class for a row that only lines buttons up.
  `conventions.test.ts` lists the rows that still have one because they do more (a grid on
  phones, their own gap or button sizes). A dialog's answers stay in `.dialog-actions`.

### Field and CheckRow (`components/Field.tsx`)

A control and its words in one `<label>`, so pressing the words reaches the control and a
screen reader reads them as its name.

```tsx
<Field label="Deck name"><input value={name} onChange={…} /></Field>
<Field label="Finish"><select value={finish} onChange={…}>…</select></Field>
<Field label="Most a card may cost" error={priceError}><input inputMode="decimal" … /></Field>
<CheckRow checked={proxy} onChange={(e) => setProxy(e.target.checked)}>Proxy</CheckRow>
<CheckRow type="radio" name="who" value="me" checked={who === "me"} onChange={…}>Only me</CheckRow>
```

- `Field`: the label is 14 px bold above the control, which is an `<input>`, a `<select>` or a
  `<textarea>` (or a component that passes aria attributes on to one). With `error` the control
  gets `aria-invalid` and is described by the error, which is announced when it appears
  (`role="alert"`). `hint` is for the rare fact a label can't carry: no hint lines under fields
  (design/tokens.md, rule 5). The control's name stays the label's words alone; a hint or an
  error describes it.
- `CheckRow`: a 20 px box beside its words; the whole row is the target. Everything an
  `<input>` takes (`checked`, `onChange`, `name`, `value`, `disabled`) passes to the box.
- A control whose name is already on the page takes `aria-labelledby`; a search box or a bare
  number in a row takes `aria-label`. `conventions.test.ts` fails on an `<input>`, `<select>`
  or `<textarea>` with no name at all, and a `<label>` with no words in it doesn't count.
- A label that lays itself out (a class of its own, markup in its words, two controls) can
  stay a `<label>`: 73 plain ones moved to these components, the rest are still written out.

### BackLink (`components/BackLink.tsx`)

The way back to the page above this one: one chevron, one wording.

```tsx
<BackLink to="/decks/plans" label="Back to plans" />                          // a round 44 px button in a page's top row
<BackLink to={`/decks/${d.id}`} label={`Back to ${d.name}`} text={d.name} />   // laptops show the words
<BackLink to="/decks" label="Back to decks" text="Decks" onArt />              // in the corner of an art header
<BackLink inline to="/play" label="Back to Play online" text="Play online" />  // a line of words, no top row
```

- `text` is the place itself, not "Back". The accessible name reads "Back to" and the place:
  it is worked out from `text`, or given as `label` when the place needs more words than the
  screen shows (keep the words on screen in it). `inline` needs `text`. No "←" anywhere.
- `AreaHead` and `LabHead` draw their own from `back={{ to, label }}`.
- It is a link. The card page's Back is a `Button`: it goes back in history, wherever that was.

### Pager and ShowMore (`components/Pager.tsx`)

```tsx
<Pager label="Game history pages" page={page} pages={pages}
  onPrevious={page > 1 ? () => go(page - 1) : undefined}
  onNext={page < pages ? () => go(page + 1) : undefined} busy={query.isFetching} />
<ShowMore total={pairs.length} onToggle={() => setAll(true)} />                       // "Show all 42", then gone
<ShowMore total={rows.length} expanded={open} onToggle={() => setOpen(!open)} />      // "Show all 42" / "Show fewer"
<ShowMore total={printings.length} noun="printings" onToggle={showAll} />
```

- `Pager` is a `<nav>` with a name that says which list (`label="Game history pages"`),
  centered under its list, reading "Page 2 of 14" (no total when it isn't known); the page
  number is announced when it changes. Leave out `onPrevious` or `onNext` when there is no
  page that way: the button is off and flat, not faded. `busy` turns both off while a page
  loads. A button that is off stays focusable (`aria-disabled`), so the keyboard keeps its
  place when Next turns itself off on the last page.
- `ShowMore` is a quiet row action. With `expanded` it is a toggle and carries
  `aria-expanded`. Without it the button is gone once pressed and focus goes with it, so
  prefer the toggle for a list people tab through. A list that says what it is showing ("Show the slowest 12") keeps its own
  words.
- A list that adds a screen at a time ("Show more cards") is a plain quiet `Button`.

### PageHeader (`components/PageHeader.tsx`)

A page's title row: the `h1`, an optional line under it, and the page's actions at the end.

```tsx
<PageHeader title="What's new" />
<PageHeader title={run.name} sub={<SimLine …/>} actions={<ButtonLink variant="primary" to="/lab/try">Try a change</ButtonLink>} />
```

- One per page, first in `<main>`; it holds the page's only `h1`.
- The actions wrap under the title on a narrow screen. More than a primary and three
  secondaries go in a `MoreMenu` (see ActionBar).
- The Decks, Plans and Lab areas draw theirs with `AreaHead`, `PlansHead` and `LabHead`, which
  add the area's sections and its `BackLink`.
