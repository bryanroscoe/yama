# Spec: Vizier of Many Faces becomes a Zombie when cast, not only when embalmed

Scenario: `card-vizier-of-many-faces` (card sweep, batch 2).

## 1. Card

- **Vizier of Many Faces** {2}{U}{U}, Creature — Shapeshifter Cleric, 0/0. "You may have this creature enter as a copy of any creature on the battlefield, except if this creature was embalmed, the token has no mana cost, it's white, and it's a Zombie in addition to its other types. / Embalm {3}{U}{U}"
  - Ruling 2017-04-18: "The token is a Zombie in addition to its other types and is white instead of its other colors. It has no mana cost, and thus its mana value is 0." (This is about the embalmed token.)
  - Ruling 2017-04-18: "Vizier of Many Faces copies exactly what was printed on the original creature ... It doesn't copy ... any non-copy effects that have changed its power, toughness, types, color, or so on."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Island, Island, Wastes, Wastes. Seat 0 casts Vizier of Many Faces from its hand. As it enters, seat 0 chose to copy seat 1's Serra Angel (both engines made that choice).

## 3. Correct result

Seat 0 controls a Serra Angel: 4/4, creature type Angel only, white, mana cost {3}{W}{W}, flying and vigilance. It is **not** a Zombie and it is not a token. (Forge matches.)

## 4. Why

1. "You may have this creature enter as a copy ..." is an as-enters replacement (614.1c) that applies a copy effect (707.2).
2. The exception's three changes (no mana cost, white, Zombie in addition) are conditional: "except **if this creature was embalmed**". A creature is embalmed only if it is a token created by a resolving embalm ability (702.128b). A Vizier cast from hand wasn't embalmed, so none of the exceptions apply and the copiable values are exactly Serra Angel's (707.2, 707.9b applies only when the exception applies).

## 5. What phase did

The copy's types were [Angel, Creature, Zombie]; P/T 4/4 was right.

## 6. Variations to test

- Embalm Vizier from the graveyard ({3}{U}{U}, exile it) and have the token copy Serra Angel: token Serra Angel that is white, has no mana cost (mana value 0), and is an Angel Zombie.
- Cast Vizier copying a blue creature: the copy is blue (the "it's white" part also only applies when embalmed), with the copied mana cost and mana value.
- Another object that later copies the cast Vizier-as-Serra: it's a plain Serra Angel copy, no Zombie.
- Vizier entering without copying anything: 0/0 Shapeshifter Cleric, dies.

## 7. Acceptance checks

- On this board, seat 0's copy of Serra Angel has creature types exactly [Angel], is 4/4, white, nontoken, with mana value 5.
