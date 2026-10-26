# Spec: Commence the Endgame draws two, then amasses Zombies X for the new hand size

Scenario: `card-commence-the-endgame` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: Forge draws two cards and creates a 0/0 Zombie Army with three +1/+1 counters. Phase moves the spell from the stack to the graveyard with no effect and no "effect resolves" line: no draw, no Army.

## 1. Card

- **Commence the Endgame** ({4}{U}{U} instant): "This spell can't be countered. Draw two cards, then amass Zombies X, where X is the number of cards in your hand. (Put X +1/+1 counters on an Army you control. It's also a Zombie. If you don't control an Army, create a 0/0 black Zombie Army creature token first.)"

Rulings (Scryfall):
- "You draw two cards and amass X all while Commence the Endgame is resolving. Nothing can happen between the two, and no player may choose to take actions."
- "To amass Zombies N, if you don't control an Army creature, create a 0/0 black Zombie Army creature token. Then you choose an Army creature you control and put N +1/+1 counters on it."
- "If you don't control an Army, the Zombie Army token you create enters the battlefield as a 0/0 creature before receiving counters."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with 2 Islands, 4 Wastes and Grizzly Bears; hand Commence the Endgame and a Wastes; library 8 Wastes. Seat 0 casts Commence the Endgame.

## 3. Correct result

1. While it's on the stack, seat 0's hand is one card (Wastes).
2. Draw two: hand three Wastes, library 6.
3. X is counted when the amass instruction is applied, after the draw (608.2h): X = 3.
4. Amass Zombies 3 (701.47a): seat 0 controls no Army, so it creates a 0/0 black Zombie Army token, then puts three +1/+1 counters on it. It's a 3/3 and survives state-based actions (they aren't checked between the two steps).

Final: seat 0 hand three Wastes, library 6, a Zombie Army token 3/3 with three +1/+1 counters. (Forge: exactly this.)

## 4. Why

- 608.2c: "Draw two cards, then amass" — in order.
- 608.2h: "the number of cards in your hand" is determined when that part of the effect is applied, after the draw.
- 701.47a: amass creates the Army only if you don't already control one.
- "Can't be countered" doesn't change how it resolves.

## 5. What phase did

Nothing: no draw, no token. (The whole spell had no effect.)

## 6. Variations to test

- **Already control an Army:** no new token; three counters go on the existing Army, which becomes a Zombie if it isn't one.
- **Empty library:** drawing from an empty library is still attempted (121.3); X counts whatever is in hand.
- **Bigger hand:** with five other cards in hand, X = 7.
- **Counter attempt:** a counterspell targeting it doesn't counter it; it still resolves fully.

## 7. Acceptance checks

- On the sweep board seat 0 ends with three cards in hand, six in library, and one 3/3 Zombie Army token with three +1/+1 counters.
