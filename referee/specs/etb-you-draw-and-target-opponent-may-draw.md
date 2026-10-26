# Spec: Tataru Taru's enters trigger (you draw, target opponent may draw)

Root cause (observed behaviour): Tataru Taru enters and its enters trigger never goes on the stack in phase. Nobody draws, so its second ability (Treasure when an opponent draws off-turn) never gets a chance.

Scenario (card sweep, standard board; see `referee/README.md`, `referee/sweep.py`): `card-tataru-taru`.

## 1. Card

- **Tataru Taru** ({1}{W} legendary creature — Dwarf Advisor 0/3): "When Tataru Taru enters, you draw a card and target opponent may draw a card. Scions' Secretary — Whenever an opponent draws a card, if it isn't that player's turn, create a tapped Treasure token. This ability triggers only once each turn."
  - Ruling 2025-06-06: "If the target opponent is an illegal target as Tataru Taru's first ability tries to resolve, it won't resolve and none of its effects will happen. You won't draw a card."

## 2. Board and actions

Standard sweep board. Seat 0 (active, precombat main): Plains, Wastes, Grizzly Bears; hand: Tataru Taru, Wastes; library 8 Wastes. Seat 1: library 8 Wastes, hand 2 Wastes. Seat 0 casts Tataru Taru. The enters trigger's target must be seat 1 (the only opponent).

## 3. Correct result

1. Tataru Taru enters; its first ability triggers, targeting seat 1.
2. On resolution: seat 0 draws a card (mandatory). Seat 1 may draw a card (seat 1's choice).
3. If seat 1 draws: it is seat 0's turn, so Scions' Secretary triggers; on resolution seat 0 creates a **tapped** Treasure token.
Final (seat 1 draws, as in Forge): seat 0 hand [Wastes, Wastes], library 7, a tapped Treasure; seat 1 hand 3 Wastes, library 7.
Final (seat 1 declines): seat 0 hand [Wastes, Wastes], library 7; seat 1 unchanged; no Treasure.

## 4. Why

1. 603.6a: "When [this object] enters" triggers when it enters; 603.3: it goes on the stack the next time a player would receive priority, with its target chosen then (603.3d, 601.2c). Seat 1 is a legal target.
2. 608.2c: "you draw a card" is mandatory; only the opponent's draw has "may".
3. Scions' Secretary: an opponent drawing on a turn that isn't theirs triggers it; the intervening "if" is checked on trigger and resolution (603.4). "Triggers only once each turn."

## 5. What phase did

No trigger: after "Tataru Taru moves from stack to battlefield" nothing happened; nobody drew; no Treasure.

## 6. Variations to test

- Seat 1 declines the draw: seat 0 still draws; no Treasure.
- On the opponent's own turn (Tataru Taru with flash via another effect, or the opponent drawing in their draw step): no Treasure ("if it isn't that player's turn").
- The opponent draws twice in one of seat 0's turns (e.g. Divination-like effect on them): only one Treasure that turn.
- Opponent gains hexproof in response: trigger doesn't resolve; seat 0 doesn't draw (ruling).

## 7. Acceptance checks

- When Tataru Taru enters, its controller always draws one card (unless the target became illegal).
- If the opponent chooses to draw during Tataru Taru's controller's turn, its controller gets one tapped Treasure.
