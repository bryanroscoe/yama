# Spec: "If ... If ... Otherwise ..." runs the "Otherwise" branch after an earlier "If" matched

Scenario: `card-misfortune-teller` (card sweep, batch 2).

## 1. Card

- **Misfortune Teller** {3}{B}, Creature — Human Warlock, 3/1. "Deathtouch / Whenever this creature enters or deals combat damage to a player, exile target card from a graveyard. If it was a creature card, create a 2/2 black Rogue creature token. If it was a land card, create a Treasure token. Otherwise, you gain 3 life."
  - Ruling 2022-04-29: "If the card was both a land and a creature (such as Dryad Arbor), you will create both a Rogue token and a Treasure token."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Swamp + 3 Wastes. Seat 0 casts Misfortune Teller; its enters trigger targets **Hill Giant in seat 1's graveyard** and resolves.

## 3. Correct result

Hill Giant is exiled. It was a creature card, so seat 0 creates a 2/2 black Rogue token. It wasn't a land card, so no Treasure. Because one of the earlier conditions was met, the "Otherwise" clause does **not** apply: seat 0 gains no life and stays at 20. (Forge matches.)

## 4. Why

1. 608.2c: follow the instructions in order, reading the whole text by the rules of English.
2. "Otherwise" means "if none of the preceding conditions was true". The ruling confirms the "If" clauses are independent of each other (a land creature gets both tokens), and life is gained only when the card was neither a creature card nor a land card.
3. Hill Giant is a creature card, so the first condition is true and the "Otherwise" is false.

## 5. What phase did

Exiled Hill Giant, created the Rogue token **and** gained 3 life (seat 0 at 23).

## 6. Variations to test

- Target Divination (sorcery): no token, gain 3 life.
- Target a basic land card: Treasure only, no life.
- Target a land creature card such as Dryad Arbor: Rogue and Treasure, no life.
- Target card leaves the graveyard before resolution: target illegal, nothing happens (608.2b), no life.
- Check other cards with an "If A, X. If B, Y. Otherwise, Z." shape behave the same way.

## 7. Acceptance checks

- On this board, after the trigger resolves, Hill Giant is in seat 1's exile, seat 0 controls one 2/2 black Rogue token and no Treasure, and seat 0's life is 20.
