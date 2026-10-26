# Spec: Collision of Realms skips the reveal and shuffles itself into its owner's library

Scenario: `card-collision-of-realms` (card sweep, batch 2).

Related: `back-references-resolve-to-wrong-object.md` (Part D, Beacon of Unrest; Part A, Creative Technique's reveal that finds nothing), written by other triagers, also involves a spell ending in the wrong zone. `revealed-cards-chosen-and-rest-misrouted.md` covers other reveal-and-move steps.

## 1. Card

- **Collision of Realms** {6}{R}, Sorcery. "Each player shuffles all creatures they own into their library. Each player who shuffled a nontoken creature into their library this way reveals cards from the top of their library until they reveal a creature card, then puts that card onto the battlefield and the rest on the bottom of their library in a random order."
  - Ruling 2022-02-18: "All creatures are shuffled into their owners' libraries at the same time. Then all players who shuffled nontoken creatures into their library this way reveal cards. Then all creature cards revealed this way enter the battlefield at the same time. Then all other cards are put on the bottom of their owners' libraries."
  - Ruling 2022-02-18: "Each player reveals and puts onto the battlefield one creature card or fewer."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Mountain + 6 Wastes. Seat 0 casts Collision of Realms; it resolves.

## 3. Correct result

1. Seat 0 shuffles its Grizzly Bears into its library (9 cards). Seat 1 shuffles its Grizzly Bears and Serra Angel into its library (10 cards).
2. Both shuffled a nontoken creature, so both reveal from the top until they reveal a creature card. Seat 0 finds Grizzly Bears (the only creature in its library); seat 1 finds whichever of its Grizzly Bears or Serra Angel comes first (random, from the shuffle).
3. Those two creature cards enter the battlefield at the same time. The other revealed cards go to the bottom of their owners' libraries in a random order.
4. Collision of Realms goes to seat 0's graveyard.

Final: seat 0 controls its lands and Grizzly Bears; library 8; graveyard Collision of Realms, Divination, Hill Giant. Seat 1 controls Millstone, Seal of Fire and one of Grizzly Bears / Serra Angel; library 9. (Forge matches, with Serra Angel as seat 1's random find.)

## 4. Why

1. "Creatures" without "card" means creature permanents on the battlefield (109.2). Collision of Realms itself is a sorcery on the stack and is never shuffled.
2. The reveal is mandatory for each player who shuffled a nontoken creature; they put the first creature card revealed onto the battlefield (one at most, ruling).
3. 608.2n: as the final step of resolution an instant or sorcery goes to its owner's graveyard.

## 5. What phase did

- Shuffled all three creatures into their owners' libraries, then nobody revealed anything and no creature entered.
- Collision of Realms went from the stack into **seat 0's library** (seat 0 library 10 = 8 Wastes + Grizzly Bears + Collision of Realms), not to the graveyard.

## 6. Variations to test

- A player whose only creatures are tokens: the tokens go to the library and cease to exist (704.5d); that player doesn't reveal.
- A player who shuffled a creature but whose library then has no creature card can't happen with nontoken creatures, but test a library where the creature card is last: all other cards revealed, then go to the bottom in random order.
- A creature seat 1 controls but seat 0 owns goes into seat 0's library.
- One creature per player even if a player shuffled several.

## 7. Acceptance checks

- On this board, after Collision of Realms resolves: seat 0 controls Grizzly Bears and has 8 cards in library; seat 1 controls exactly one of Grizzly Bears / Serra Angel and has 9 cards in library; Collision of Realms is in seat 0's graveyard.
