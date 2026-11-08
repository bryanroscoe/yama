# Plans: the redesign and what changed on 8 Nov

The plans redesign (one plan per deck, one state, one Approve, versions, Get the cards, Archived) is
built: see ARCHITECTURE.md, "Plans: one plan per deck (2026-11-06)". Its boards are on the
"Plans" page of the Yama redesign canvas, mirrored in `design/screens/redesign-2026-11/`
(Main, ProposedPlan, InProgress, GetCards, NewVersion, Archived and the four phone boards).

What the boards gained on 8 Nov, for the next pass on `web/src/plan`:

1. **Both cards on every change.** Each change row shows the card going in, an arrow, then the card it
   replaces, with "replaces" in the text; tap either for the full card. Also on a new version's
   added changes and on what's left of a plan in progress. A change with no cut named shows a dashed
   empty slot.
2. **Laptop density.** 36 px controls, a 40 px primary, 32 px Skip and Undo, 10 px corners on
   secondaries; heroes about 220 px with a 64 px title. Phones unchanged.
3. **Section tabs.** A plan waiting for your OK: Changes (count), Questions (count), How it plays,
   all open (How it plays is no longer a fold). A plan in progress: Left to do, In the deck,
   Brackets, Lists. The approve panel stays in view while you scroll.
4. **No micro copy.** Hint lines and explanations go behind one "?" per section.
5. **The deck page's Plan tab** is the way into a deck's plan from its deck: current plan (progress,
   next step, what's left), up next (versions or builds waiting for your OK) and earlier, with a link
   to the plan page. See `deck-page/SPEC.md`.

Open: Revival Trance's real count of changes left (the plan file and Yama's marks disagreed when the
boards were drawn).
