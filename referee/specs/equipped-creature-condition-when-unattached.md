# Spec: "as long as equipped creature is ..." with no equipped creature

Root cause (observed behaviour): an Equipment whose static abilities are conditioned on the state of "equipped creature" applies one of them while it is attached to nothing. phase treated "equipped creature is untapped" as true for an unattached Sword of the Paruns.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-sword-of-the-paruns`.

## 1. Card

Oracle text and rulings from Scryfall.

- **Sword of the Paruns** ({4} Artifact — Equipment): "As long as equipped creature is tapped, tapped creatures you control get +2/+0. As long as equipped creature is untapped, untapped creatures you control get +0/+2. {3}: You may tap or untap equipped creature. Equip {3}"
  - 2024-01-12: "If equipped creature becomes tapped, untapped creatures you control will immediately lose the +0/+2 bonus. ..."

## 2. Board and actions

Seat 0 (active, main phase 1): four Wastes, untapped Grizzly Bears (2/2). Seat 0 casts Sword of the Paruns (tapping the four Wastes); it resolves and is not equipped to anything. The run ends there.

## 3. Correct result

Sword of the Paruns is unattached, so there is no equipped creature and neither static ability applies. **Seat 0's Grizzly Bears is 2/2.** Seat 1's creatures are unaffected in any case ("creatures you control").

## 4. Why

1. 301.5a: "The creature an Equipment is attached to is called the 'equipped creature.'" 301.5f: an ability that refers to "equipped creature" refers to whatever creature the permanent is attached to.
2. An unattached Equipment has no equipped creature, so "equipped creature is tapped" and "equipped creature is untapped" are both false (there is no creature for them to describe). Neither "as long as" condition holds, so neither effect applies (611.3a: a static effect applies to whatever its text indicates at that moment).
3. The ruling ties the bonus to the equipped creature's state; it exists only through an equipped creature.

## 5. What phase did

Grizzly Bears was 2/4 (the +0/+2 of the "untapped" ability). Forge: 2/2.

## 6. Variations to test

- **Equipped, untapped:** equip Sword to Grizzly Bears (Equip {3}): untapped creatures seat 0 controls get +0/+2, so Bears 2/4 and any other untapped creature of seat 0 +0/+2; tapped creatures get nothing.
- **Equipped, tapped:** tap the equipped Bears (e.g. with the Sword's {3} ability): tapped creatures seat 0 controls get +2/+0, untapped ones get nothing.
- **Equipped creature leaves:** the Bears dies; the Sword becomes unattached (301.5c SBA) and both bonuses stop.
- **Equipped to an opponent's creature?** Not possible via Equip (only your creatures), but if control of the equipped creature changes, "creatures you control" still means the Sword's controller.
- **Same pattern elsewhere:** other "as long as equipped/enchanted creature is ..." conditions (e.g. "as long as enchanted creature is a ...") should be false when nothing is attached.

## 7. Acceptance checks

- With Sword of the Paruns on the battlefield and attached to nothing, every creature has its normal power and toughness.
- Once attached to an untapped creature, untapped creatures its controller controls get +0/+2; once that creature is tapped, tapped creatures get +2/+0 instead.
