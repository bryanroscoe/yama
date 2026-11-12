# ActionBar

A page's actions as one row: the primary, at most three secondaries, and a More button that opens a floating menu.

- Laptop: 36 px secondaries (`r-control` 10 px radius, `raised`, 16 px icon plus label), a 40 px primary pill, 8 px apart.
- More opens a popover anchored to the button (laptop) or a bottom sheet (phone). It never expands inline and never pushes the page down.
- The menu: 36 px rows (48 px in the phone sheet), at most about 7 items, grouped by hairlines (do, share and export, destructive), destructive last in `bad`.
- Which actions get a button: the ones people use most. Everything else lives in More.
- The bar sits at least 16 px (`stack-gap`) below the content above it.

Replaces the inline "More" expander that dropped a second and third row of pills onto the deck page.

In the app the row is `ActionBar` and the menu is `MoreMenu` (`web/src/components`; [shared-code.md](../../shared-code.md)).
