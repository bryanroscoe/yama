# Spec: excess damage is only the damage beyond lethal

Scenario: `card-bottle-cap-blast` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: both engines deal 5 damage to seat 1's Grizzly Bears and it dies. Forge creates 3 tapped Treasures; phase creates 5.

## 1. Card

- **Bottle-Cap Blast** ({4}{R} instant): "Improvise (Your artifacts can help cast this spell. Each artifact you tap after you're done activating mana abilities pays for {1}.) Bottle-Cap Blast deals 5 damage to any target. If excess damage was dealt to a permanent this way, create that many tapped Treasure tokens."

Rulings (Scryfall):
- "Excess damage has been dealt to a creature if the damage dealt to it is greater than lethal damage. Usually, this means damage greater than its toughness, although damage already marked on the creature is taken into account."
- "For a planeswalker, excess damage means damage in excess of the planeswalker's loyalty ... For a battle, ... in excess of the battle's defense."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with Mountain, 4 Wastes and Grizzly Bears. Seat 1's Grizzly Bears is 2/2 with no damage. Seat 0 casts Bottle-Cap Blast targeting seat 1's Grizzly Bears.

## 3. Correct result

1. 5 damage is dealt to the Bears.
2. Lethal damage for a 2/2 with no damage marked is 2 (120.6). Excess damage is 5 − 2 = **3** (120.4a, 120.10, ruling).
3. Seat 0 creates 3 tapped Treasure tokens (111.10a).
4. The Bears dies (704.5g).

Final: seat 0 has exactly three tapped Treasures; seat 1's Bears is in its graveyard. (Forge: exactly this.)

## 4. What phase did

Created 5 Treasures: it counted all the damage dealt as excess.

## 5. Variations to test

- **Damage already marked:** the Bears has 1 damage; lethal is 1; excess 4 → 4 Treasures.
- **Bigger creature:** Serra Angel 4/4 → excess 1 → 1 Treasure. A 6/6 → excess 0 → no Treasures.
- **A player target:** excess damage only applies to permanents → no Treasures.
- **Planeswalker with 3 loyalty:** excess 2 → 2 Treasures.
- **Indestructible 2/2:** excess is still 3 (damage beyond lethal), even though it doesn't die.
- **Deathtouch source** (not this card, but the same rule, 120.4a/702.2c): any damage beyond 1 is excess.
- **Prevention:** if some of the damage is prevented (e.g. prevent 2), only the damage actually dealt counts: 3 dealt to a 2/2 → excess 1.

## 6. Acceptance checks

- 5 damage to an undamaged 2/2 creates exactly 3 tapped Treasures.
- The excess amount is the damage dealt minus the lethal damage the permanent needed at that moment, never less than 0.
