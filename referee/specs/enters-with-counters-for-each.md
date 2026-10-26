# Spec: "Enters with a +1/+1 counter for each ..." counts the wrong things

Scenarios: `card-ascendant-acolyte`, `card-ulasht-the-hate-seed` (card sweep, batch 2).

Both cards enter with a number of +1/+1 counters equal to a count of other objects. phase got the count wrong both ways: one too many for Ascendant Acolyte, one too few for Ulasht. Forge is right in both.

## 1. Cards

- **Ascendant Acolyte** {4}{G}, Creature — Human Monk, 1/1. "This creature enters with a +1/+1 counter on it for each +1/+1 counter among other creatures you control. / At the beginning of your upkeep, double the number of +1/+1 counters on this creature."
  - Ruling 2022-02-18: "If Ascendant Acolyte is entering the battlefield at the same time as other creatures, it doesn't count any counters those other creatures would enter the battlefield with."
- **Ulasht, the Hate Seed** {2}{R}{G}, Legendary Creature — Hellion Hydra, 0/0. "Ulasht enters with a +1/+1 counter on it for each other red creature you control and a +1/+1 counter on it for each other green creature you control. / {1}, Remove a +1/+1 counter from Ulasht: Choose one — • Ulasht deals 1 damage to target creature. • Create a 1/1 green Saproling creature token."
  - Ruling 2006-02-01: "Creatures that are both red and green provide two +1/+1 counters."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

- `card-ascendant-acolyte`: lands Forest + 4 Wastes. Seat 0 casts Ascendant Acolyte; it resolves.
- `card-ulasht-the-hate-seed`: lands Mountain, Forest, Wastes, Wastes. Seat 0 casts Ulasht; it resolves.

## 3. Correct result

- **Ascendant Acolyte** enters with **no** counters: the only other creature seat 0 controls is Grizzly Bears, which has no +1/+1 counters. Acolyte is a 1/1. (Forge: 1/1, no counters.)
- **Ulasht** enters with **one** +1/+1 counter: seat 0's other creatures are one Grizzly Bears, which is green and not red. Ulasht is a 1/1 and stays on the battlefield. (Forge: 1/1 with one counter.)

## 4. Why

1. "[This permanent] enters with ..." is a replacement effect (614.1c, 614.12): the permanent is put onto the battlefield with those counters already on it (122.6).
2. The number is determined as the replacement effect is applied, from the game state just before the permanent enters (608.2h for the information; the Acolyte ruling confirms that only creatures already on the battlefield count).
3. Acolyte counts **+1/+1 counters**, not creatures, and only on **other** creatures **you control**. Seat 0 has one other creature with zero counters, so the count is 0. Seat 1's creatures don't count.
4. Ulasht counts other **red** creatures you control and, separately, other **green** creatures you control. Grizzly Bears is green (its mana cost is {1}{G}; 105.2), so the green count is 1 and the red count is 0: one counter. Seat 1's creatures don't count. Ulasht's base P/T is 0/0, so without the counter it would die to 704.5f.

## 5. What phase did

- Ascendant Acolyte entered with one +1/+1 counter (2/2). It looks as though phase counted the other creature rather than the counters on it, but the spec only fixes the result.
- Ulasht entered with no counters, was 0/0 and was put into the graveyard.

## 6. Variations to test

- Acolyte when seat 0's Bears has two +1/+1 counters: Acolyte enters with two. With two creatures carrying 1 and 3 counters: four.
- Acolyte ignores -1/-1 counters and other kinds of counters, and counters on opponents' creatures.
- Acolyte entering at the same time as a creature that enters with counters: those don't count.
- Ulasht with a red creature and a green creature: two counters. With one red-and-green creature: two counters (ruling). With an opponent's green creature only: zero, and it dies.
- Ulasht ignores itself (it's red and green) — "other".

## 7. Acceptance checks

- On this board, Ascendant Acolyte is on the battlefield as a 1/1 with no counters.
- On this board, Ulasht is on the battlefield as a 1/1 with exactly one +1/+1 counter, and seat 0's graveyard is unchanged (Divination, Hill Giant).
