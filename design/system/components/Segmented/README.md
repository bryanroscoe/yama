# Segmented

A pill track for switching views of the same thing: the Decks sections, or which bracket a plan's changes show.

- `surface` track, 3 px padding; the selected segment is a `text` pill with `ground` text; the rest are `dim` text.
- Each segment is a 36 px button on a laptop (`pointer: fine`) and 44 px on phones, with `aria-pressed` (or a link with `aria-current="page"` for navigation).
- Two to five segments. More than that, or segments that are different tasks, means it should be separate pages, not a control.
- It never stands in for tabs that hide unrelated content: a plan page shows its changes once, with the bracket picker filtering them.
