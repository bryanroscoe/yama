# Spec: Baleful Mastery exiles its target whichever cost was paid

Scenario: `card-baleful-mastery` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: cast for its mana cost targeting seat 1's Grizzly Bears, Forge exiles the Bears (no draw). Phase moves Baleful Mastery from the stack to the graveyard with no effect and no "effect resolves" line; the Bears stays.

## 1. Card

- **Baleful Mastery** ({3}{B} instant): "You may pay {1}{B} rather than pay this spell's mana cost. If the {1}{B} cost was paid, an opponent draws a card. Exile target creature or planeswalker."

Rulings (Scryfall):
- "If you copy a 'Mastery' spell and the alternative cost was paid, the copy will resolve as though the cost was paid."
- "In a multiplayer game, you choose which opponent takes the prescribed action as the spell resolves."
- "If an effect increases or decreases the cost of spells you cast, that cost increase or decrease is applied to the alternative cost you chose to pay. In that case, the cost was still paid for the purposes of the effect."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with Swamp, 3 Wastes and Grizzly Bears. Seat 0 casts Baleful Mastery for its normal mana cost {3}{B} (the referee always picks the normal cost) targeting seat 1's Grizzly Bears.

## 3. Correct result

1. The alternative cost wasn't paid, so the conditional sentence does nothing: seat 1 draws nothing.
2. "Exile target creature or planeswalker" is unconditional: the Bears is exiled.

Final: seat 1's exile [Grizzly Bears]; seat 1's hand two Wastes, library 8; Baleful Mastery in seat 0's graveyard. (Forge: exactly this.)

## 4. Why

- 608.2c: the instructions are followed in order; "If the {1}{B} cost was paid" governs only its own sentence. The exile sentence stands alone.
- 601.2b/601.2f: the alternative cost is an option chosen while casting; choosing not to use it doesn't remove the spell's other effects.
- The target is still legal (608.2b), so the spell resolves.

## 5. What phase did

Resolved with no effect at all: the Bears stayed on the battlefield (and nobody drew).

## 6. Variations to test

- **Alternative cost paid** (Swamp + Wastes, choose {1}{B}): the Bears is exiled **and** seat 1 draws a card (hand 3, library 7).
- **Planeswalker target:** exiled the same way.
- **Target gone:** the Bears leaves before resolution → the spell doesn't resolve (608.2b), so even with {1}{B} paid the opponent draws nothing.
- **Copy:** a copy of a Baleful Mastery cast for {1}{B} also makes an opponent draw (ruling).
- The other Strixhaven "Mastery" cards use the same template ("You may pay [cost] rather than pay this spell's mana cost. If the [cost] cost was paid, ..."): their unconditional sentences always happen, and the conditional one only when that cost was paid.

## 7. Acceptance checks

- Cast for {3}{B}: the target is exiled; no card is drawn.
- Cast for {1}{B}: the target is exiled and one opponent draws one card.
