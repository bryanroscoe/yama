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
- Destructive actions use `bad` text on a secondary pill and say what they remove.

The consumer provides the label and the handler; use a real `<button>` or a styled `<a>` for navigation.
