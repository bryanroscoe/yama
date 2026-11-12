# StatusPill

A small pill of status text on its own tint: the one way Yama shows a state.

- `good` on `good-tint`: have it, in the deck, done, legal.
- `warn` on `warn-tint`: need it, waiting, waiting for your OK.
- `bad` on `bad-tint`: banned, failed. Always with a word that says what.
- Neutral (`dim` text, 1 px `line` border): archived, not checked.
- 13 px bold, sentence case, pill radius, no icon needed. One pill per thing; never use a pill for a version, a date or a source: write those as plain text.

In the app this is `StatusPill` (`tone="good" | "warn" | "bad"`, neutral with none) and `Tag` for a label that names a kind (`web/src/components/StatusPill.tsx`; [shared-code.md](../../shared-code.md)).
