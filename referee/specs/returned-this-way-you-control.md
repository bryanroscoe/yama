# Spec: Flood of Tears counts permanents other players controlled toward "four or more ... you control"

Scenario: `card-flood-of-tears` (card sweep, batch 2).

Related: `amounts-from-objects-affected-this-way.md` (counts of what a spell just did), but here phase over-counts rather than under-counts.

## 1. Card

- **Flood of Tears** {4}{U}{U}, Sorcery. "Return all nonland permanents to their owners' hands. If you return four or more nontoken permanents you control this way, you may put a permanent card from your hand onto the battlefield."
  - Ruling 2019-07-12: "If you return four or more nontoken permanents, the permanent card you put onto the battlefield may be one of the cards returned to your hand this way."
  - Ruling 2019-07-12: "If a permanent would be returned to your hand but ends up in another zone ... Flood of Tears counts it when determining whether four or more of your nontoken permanents were returned."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Island, Island + 4 Wastes. Seat 0 casts Flood of Tears; it resolves.

## 3. Correct result

Returned to hands: seat 0's Grizzly Bears, and seat 1's Grizzly Bears, Serra Angel, Millstone and Seal of Fire. Lands stay. Only **one** of the returned permanents (seat 0's Grizzly Bears) is a nontoken permanent seat 0 controlled, so the "four or more" condition is false and seat 0 may **not** put a permanent card onto the battlefield. Final: seat 0's hand is Grizzly Bears and Wastes; seat 0 controls only its lands. (Forge matches.)

## 4. Why

1. "This way" refers to what this spell just did (608.2c); the count is taken once, when that part of the effect is applied (608.2h).
2. The condition counts permanents that were returned by this spell, were nontoken, and were controlled by **you**, the spell's controller. Seat 1's four permanents don't count. Lands weren't returned, and Flood of Tears is a spell on the stack, not a permanent.
3. 1 < 4, so the optional put isn't offered.

## 5. What phase did

Returned all five nonland permanents, then put seat 0's Grizzly Bears back onto the battlefield as if the condition were met (it looks like a count of all returned permanents, five, but the spec only fixes the result).

## 6. Variations to test

- Seat 0 controls four nontoken nonland permanents: it may put a permanent card (possibly one just returned) onto the battlefield.
- Three nontoken permanents plus two tokens of seat 0's: condition false (tokens don't count).
- A permanent seat 0 controls but an opponent owns: it counts ("you control") and goes to its owner's hand.
- A returned permanent that ends up in another zone (e.g. a commander going to the command zone): still counts (ruling).

## 7. Acceptance checks

- On this board, after Flood of Tears resolves, seat 0's Grizzly Bears is in seat 0's hand (not on the battlefield), and seat 1's Grizzly Bears, Serra Angel, Millstone and Seal of Fire are in seat 1's hand.
