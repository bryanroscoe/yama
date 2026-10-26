# Spec: Wall of Stolen Identity's "When you do, tap the copied creature"

Root cause (observed behaviour): Wall of Stolen Identity entered as a copy of Serra Angel in phase, but the reflexive trigger ("When you do, tap the copied creature ...") resolved without tapping the original Serra Angel.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-wall-of-stolen-identity`.

## 1. Card

Oracle text and rulings from Scryfall.

- **Wall of Stolen Identity** ({3}{U} Creature — Shapeshifter Wall 0/0): "You may have this creature enter as a copy of any creature on the battlefield, except it's a Wall in addition to its other types and has defender. When you do, tap the copied creature and it doesn't untap during its controller's untap step for as long as you control this creature."
  - 2019-08-23: "Once Wall of Stolen Identity has entered the battlefield and stolen a creature's identity, players can take actions before the creature is tapped."
  - 2019-08-23: "Wall of Stolen Identity can copy a tapped creature. That creature just remains tapped and doesn't untap during its controller's next untap step for as long as you control Wall of Stolen Identity."
  - 2019-08-23: "If Wall of Stolen Identity leaves the battlefield before its triggered ability has resolved, the copied creature will be tapped, but it will untap as normal."

## 2. Board and actions

Seat 0 (active, main phase 1) casts Wall of Stolen Identity; both engines chose to copy seat 1's untapped Serra Angel. The reflexive trigger then resolves.

## 3. Correct result

- Seat 0 controls a Serra Angel copy (also a Wall, with defender).
- **Seat 1's Serra Angel is tapped**, and it won't untap during seat 1's untap steps for as long as seat 0 controls the Wall. (Forge: tapped.)

## 4. Why

1. Choosing to copy is the "you do" (603.12): the reflexive trigger is created by the replacement effect as the Wall enters and triggers because the action was taken.
2. "The copied creature" is the creature chosen to copy (seat 1's Serra Angel), not the Wall itself (which is now also named Serra Angel). Tapping it is mandatory.
3. The "doesn't untap" part is a continuous effect lasting as long as seat 0 controls the Wall (611.2b).

## 5. What phase did

The log shows "Serra Angel's effect resolves" three times; seat 1's Serra Angel ended **untapped**. (Its own Wall-copy was fine.)

## 6. Variations to test

- **Untap step:** pass to seat 1's turn: its Serra Angel stays tapped. Destroy the Wall: on seat 1's next untap step Serra Angel untaps.
- **Control change:** seat 1 gains control of the Wall: the "doesn't untap" effect ends (ruling).
- **Wall leaves before the trigger resolves:** Serra Angel is still tapped, but untaps normally later (ruling).
- **Copying one's own creature:** copying seat 0's Grizzly Bears taps seat 0's Grizzly Bears (the copied creature), not the Wall.
- **Declining to copy:** no trigger; the Wall enters as a 0/0 and dies (704.5f).
- **Name confusion:** the copied creature and the Wall have the same name; the tap must hit the original, identified as an object, not by name.

## 7. Acceptance checks

- When Wall of Stolen Identity copies a creature, that original creature becomes tapped and stays tapped through its controller's untap steps while the Wall's controller controls the Wall.
- The Wall itself is not tapped by this ability.
