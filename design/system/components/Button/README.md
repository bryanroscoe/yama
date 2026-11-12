# Button

One primary per view, raised or outlined secondaries, and quiet text buttons for small undoable actions, in two densities.

- **Laptop** (`pointer: fine`): secondary 36 px with a 10 px radius, primary a 40 px pill, row actions (Skip, Undo) 32 px, labels 14-15 px.
- **Phone** (`pointer: coarse`): 44 px, primary 52 px, pills.
- More than three secondaries: use an ActionBar with a More menu. Never a wrapping row of pills.

- **Primary** (`text` fill, `ground` label): the one thing the view is for. "Approve plan", "Mark bought".
- **Secondary** (`raised` fill) and **outline** (transparent, 1 px `line`): everything else.
- **Quiet** (transparent): Skip, Undo, Show all. It raises on hover.
- **Waiting**: a primary that can't be used yet turns `raised` with `dim` text and says why ("Answer the question first"). Never a faded pill.
- Labels are verbs in sentence case, saying what happens. No icons-only buttons without an `aria-label`.
- A button that removes something uses `bad` text on a secondary, an outline or a quiet button (`danger`) and says what it removes; so does the Yes in an "are you sure?" question. The last step of deleting for good, in a sheet of its own (Delete deck, Delete account), is a `bad` fill (`destructive`).

The consumer provides the label and the handler; use a real `<button>` or a styled `<a>` for navigation.

In the app this is `Button` and `ButtonLink` (`web/src/components/Button.tsx`; props in [shared-code.md](../../shared-code.md)): `variant` is `primary`, `secondary`, `outline`, `quiet` or `destructive`, `size="small"` is a row action, and `danger` puts `bad` words on a secondary, an outline or a quiet button.
