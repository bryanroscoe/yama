# Spec: Necromantic Selection returns only a creature card it destroyed

Scenario: `card-necromantic-selection`. Observed: all three creatures are destroyed in both engines. Forge returns seat 1's Serra Angel under seat 0's control as a black Zombie; phase returns seat 1's Hill Giant, a card that was already in seat 1's graveyard before the spell.

## 1. Card

- **Necromantic Selection** {4}{B}{B}{B}, Sorcery. "Destroy all creatures, then return a creature card put into a graveyard this way to the battlefield under your control. It's a black Zombie in addition to its other colors and types. Exile Necromantic Selection."

Rulings (2014-11-07): it adds black and Zombie, doesn't overwrite other colors or types.

## 2. Board and actions

Sweep board: seat 0 has the lands, Grizzly Bears, and Hill Giant + Divination in its graveyard. Seat 1 has Grizzly Bears, Serra Angel, Millstone, Seal of Fire, and Hill Giant in its graveyard. Seat 0 casts Necromantic Selection; it resolves.

## 3. Correct result

- Destroyed: seat 0's Grizzly Bears, seat 1's Grizzly Bears, seat 1's Serra Angel (each to its owner's graveyard).
- Seat 0 then returns exactly one of those three cards (its choice) to the battlefield under its control; it's black and a Zombie in addition to its other colors and types. Forge chose Serra Angel (Creature — Angel Zombie, 4/4).
- The two Hill Giants that started in graveyards are not eligible and stay where they are.
- Necromantic Selection goes to seat 0's exile, not its graveyard.

## 4. Why

1. Instructions in order (608.2c): first destroy all creatures (701.8a), then return "a creature card put into a graveyard this way".
2. "This way" limits the choice to cards that the destroy instruction of this same spell put into a graveyard. The Hill Giants were put there before the game state began and were not put there by this spell.
3. The returned card is a new object (400.7); the effect then makes it black and a Zombie in addition (205.1b "in addition to its other ... types").
4. "Exile Necromantic Selection" replaces the usual move to the graveyard at the end of resolution (608.2n is the default).

## 5. What phase did

Destroyed the three creatures correctly, but returned seat 1's Hill Giant, which was in seat 1's graveyard from the start.

## 6. Variations to test

- No creature dies (e.g. the only creature is indestructible): nothing is returned.
- A destroyed token: it went to a graveyard but ceases to exist, so there's no card to return.
- A creature that would die but is exiled instead by a replacement effect (e.g. Rest in Peace): it wasn't put into a graveyard, so it can't be returned.
- A creature card already in a graveyard of the same name as a destroyed one: only the destroyed one is eligible.
- Contrast: Extract from Darkness ("put a creature card from a graveyard onto the battlefield") may take any creature card, including pre-existing ones.

## 7. Acceptance checks

- The returned card is always one that this spell destroyed.
- Cards that were in a graveyard before the spell are never offered.
- The returned creature is under the caster's control, black, and a Zombie in addition to its other types; the spell ends in exile.
