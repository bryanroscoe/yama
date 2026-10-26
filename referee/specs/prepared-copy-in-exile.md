# Spec: Becoming prepared creates a copy of the prepare spell in exile

Scenario: `card-inspired-skypainter`. Observed: Forge's final state has "Maestro's Gift" in seat 0's exile after Inspired Skypainter enters; phase's exile is empty. Phase's log shows the trigger resolving. Confidence is medium: if phase does track Skypainter as prepared and lets its controller cast Maestro's Gift, the gap may be only in how the copy is reported; the checks below settle it.

## 1. Card

- **Inspired Skypainter** {U}{R}, Creature — Lizard Wizard, 2/2, with prepare spell **Maestro's Gift** {3}{U}{R}, Sorcery. Creature: "Flying. When this creature enters and whenever one or more creature tokens you control deal combat damage to a player, this creature becomes prepared. (While it's prepared, you may cast a copy of its spell. Doing so unprepares it.)" Maestro's Gift: "Create a token that's a copy of target creature you control. That token gains haste until end of turn."

Rulings (2026-03-20):
- "As an effect causes a creature with a prepare spell to become prepared ..., that creature's controller creates a copy of that creature's prepare spell in exile. That copy remains in exile for as long as that permanent is on the battlefield and is prepared. That creature's controller may cast that copy as long as it remains in exile."
- "While copies of spells in zones other than the stack cease to exist when state-based actions are checked, this does not apply to copies of prepare spells in exile that were created as a creature became prepared."
- "A creature with a prepare spell can't become prepared more than once at the same time."

## 2. Board and actions

Sweep board: seat 0 has Island, Mountain, Grizzly Bears. Seat 0 casts Inspired Skypainter; it resolves and enters; its enters trigger resolves.

## 3. Correct result

- Inspired Skypainter is on the battlefield with the prepared designation.
- Seat 0's exile contains a copy of Maestro's Gift (a blue and red sorcery named Maestro's Gift with mana cost {3}{U}{R}), which seat 0 may cast.
- Nothing else changes.

## 4. Why

1. The trigger makes Skypainter become prepared (722.3a): it has a prepare spell, so it gains the prepared designation.
2. 722.3c: as it gains the designation, its controller creates a copy of it in exile with only the prepare spell's characteristics. The copy stays in exile while Skypainter is on the battlefield and prepared; this is an exception to 704.5e. Its controller may cast the copy; doing so removes the designation (601.2i).

## 5. What phase did

No object in seat 0's exile after the trigger resolved. Whether Skypainter is prepared isn't visible in the report.

## 6. Variations to test

- Cast the Maestro's Gift copy from exile (pay {3}{U}{R}), targeting Grizzly Bears: a hasty token copy of Bears; Skypainter is no longer prepared; the copy left exile.
- Skypainter leaves the battlefield while prepared: the copy in exile ceases to exist.
- Skypainter already prepared and its trigger happens again (creature tokens deal combat damage): it isn't prepared twice; still one copy in exile.
- Skypainter loses all abilities while prepared: it stays prepared and the copy stays (ruling).
- A creature that copies Skypainter isn't prepared (prepared isn't copiable).

## 7. Acceptance checks

- After Inspired Skypainter enters, it's prepared and exactly one Maestro's Gift copy is in its controller's exile.
- The controller can cast that copy, which unprepares Skypainter.
- The copy disappears if Skypainter leaves the battlefield.

## Added from triage batch 5: Sanar, Unfinished Genius

Scenario: `card-sanar-unfinished-genius`. **Sanar, Unfinished Genius** ({U}{R} legendary creature — Goblin Sorcerer 0/4, prepare spell **Wild Idea**, {3}{U}{R} sorcery): "Sanar enters prepared. (While it's prepared, you may cast a copy of its spell. Doing so unprepares it.) {T}: Create a Treasure token. Activate only if you've cast an instant or sorcery spell this turn."

Observed: Forge's final state has "Wild Idea" in seat 0's exile after Sanar enters; phase's exile is empty (its log shows one "effect resolves" after Sanar enters).

Correct: "enters prepared" gives Sanar the prepared designation as it enters, and its controller creates a copy of Wild Idea in exile (722.3a, 722.3c; Sanar ruling 2026-03-20: "including effects that state that a creature 'enters prepared'"). The copy stays in exile while Sanar is on the battlefield and prepared; seat 0 may cast it; casting it unprepares Sanar. Same checks as above; additionally check the "enters prepared" path (a replacement-style entry, not a trigger) as well as the "becomes prepared" trigger path.
