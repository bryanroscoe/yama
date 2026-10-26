# Spec: Heroic Sacrifice's "when that creature dies this turn" is a delayed trigger

Scenario: `card-heroic-sacrifice` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: Forge resolves the spell and nothing else happens (the Bears doesn't die, nobody draws). Phase draws a card for seat 0 as the spell resolves.

## 1. Card

- **Heroic Sacrifice** ({1}{W} instant): "Choose target creature you control. Until end of turn, all damage that would be dealt to you and creatures you control is dealt to the chosen creature instead (if it's still on the battlefield). When that creature dies this turn, put its counters on up to one target creature you control and draw a card."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with Plains, Wastes and Grizzly Bears; hand Heroic Sacrifice and a Wastes; library 8 Wastes. Seat 0 casts Heroic Sacrifice targeting its own Grizzly Bears. No damage is dealt afterwards and nothing dies.

## 3. Correct result

1. On resolution, two things are created: a redirection effect lasting until end of turn, and a **delayed triggered ability** "when that creature dies this turn, put its counters on up to one target creature you control and draw a card" (603.7, 603.7a).
2. A delayed trigger does nothing until its event happens (603.7a). The Bears doesn't die, so the ability never triggers: no counters move and no card is drawn.

Final: seat 0 hand [Wastes], library 8. (Forge: exactly this.)

## 4. Why

- 603.7 / 603.7a: "When [event] this turn, ..." inside a resolving spell creates a delayed triggered ability; it triggers only when that event occurs.
- 603.7b: with the stated duration "this turn", it can trigger only during this turn.
- 608.2c: the draw is part of the delayed ability's effect, not an instruction of the spell.

## 5. What phase did

Drew a card for seat 0 while Heroic Sacrifice resolved (hand two Wastes, library 7), although the Bears never died.

## 6. Variations to test

- **The creature dies.** After Heroic Sacrifice resolves, seat 0 casts Lightning Bolt targeting seat 0 (the player): the 3 damage is dealt to Grizzly Bears instead, it dies, the delayed trigger fires, seat 0 draws one card. Seat 0's life stays 20.
- **Counters move.** As above, but the Bears had two +1/+1 counters (4/4) and takes 4+ damage; when it dies, seat 0 may put two +1/+1 counters on up to one other creature it controls, then draws.
- **"Up to one" with no other creature.** The trigger still draws a card even with no target chosen.
- **Dies next turn.** The Bears dies on a later turn: no draw (603.7b, "this turn").
- **Creature leaves another way.** The Bears is exiled or bounced: it didn't die, no trigger.
- **Damage to other creatures.** While the effect lasts, damage to seat 0's other creatures is dealt to the Bears instead.

## 7. Acceptance checks

- Resolving Heroic Sacrifice alone draws no card and moves no counters.
- When the chosen creature dies later that turn, seat 0 draws exactly one card.
