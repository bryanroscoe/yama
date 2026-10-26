# Spec: "Creatures you control that are Zombies and/or tokens" also pumps nontoken non-Zombies

Scenario: `card-on-wings-of-gold` (card sweep, batch 2).

## 1. Card

- **On Wings of Gold** {3}{W}, Enchantment. "Creatures you control that are Zombies and/or tokens get +1/+1 and have flying. / Whenever one or more cards leave your graveyard, create a 1/1 white Zombie creature token."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Plains + 3 Wastes. Seat 0 casts On Wings of Gold; it resolves. No card leaves seat 0's graveyard, so no Zombie token is created.

## 3. Correct result

Seat 0's Grizzly Bears is a nontoken Bear, so the static ability doesn't affect it: it stays 2/2 without flying. Nothing else changes. (Forge matches.)

## 4. Why

1. The static ability's affected set is "creatures you control that are Zombies and/or tokens": a creature is included if it is a Zombie, or a token, or both (each such creature gets the bonus once).
2. Grizzly Bears is neither a Zombie nor a token, so it isn't in the set. The +1/+1 (layer 7c, 613.4c) and flying (layer 6) apply only to members of the set.

## 5. What phase did

Seat 0's Grizzly Bears became 3/3 (the snapshot doesn't show abilities, so whether it also got flying is unknown).

## 6. Variations to test

- A creature token (e.g. a 1/1 Soldier token) seat 0 controls: 2/2 with flying.
- A nontoken Zombie (e.g. a Zombie creature card on the battlefield): +1/+1 and flying.
- A Zombie token (e.g. the token from this card's own trigger): 2/2 flying, the bonus applied once, not twice.
- Opponents' Zombies and tokens: unaffected.
- Make a card leave seat 0's graveyard (e.g. return Hill Giant to hand): the trigger makes a 1/1 white Zombie token, which is then 2/2 with flying.

## 7. Acceptance checks

- On this board, after On Wings of Gold resolves, seat 0's Grizzly Bears is 2/2 and has no flying.
