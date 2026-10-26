# Spec: "costs {1} less for each counter among players and permanents" with no counters

Root cause (observed behaviour): phase reduced Lumbering Megasloth's cost by {10} on a board with no counters at all, so it cost only {G}{G}.

Scenario (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`): `card-lumbering-megasloth`.

## 1. Card

Oracle text and rulings from Scryfall.

- **Lumbering Megasloth** ({10}{G}{G} Creature — Sloth Mutant 8/8): "This spell costs {1} less to cast for each counter among players and permanents. Trample. This creature enters tapped."
  - 2024-03-08: "The cost-reduction ability of Lumbering Megasloth doesn't change its mana cost or mana value, only the total cost you pay. Specifically, the mana value of Lumbering Megasloth is always 12."
  - 2024-03-08: "Once you announce that you're casting Lumbering Megasloth, no player may take actions until you're done casting it."

## 2. Board and actions

Seat 0 (active, main phase 1): 2 Forests and 10 Wastes, Grizzly Bears; Megasloth in hand. Seat 1: Grizzly Bears, Serra Angel, Millstone, Seal of Fire. No permanent has counters; no player has counters (poison, energy, experience, rad, ...). Seat 0 casts Lumbering Megasloth.

## 3. Correct result

There are 0 counters among players and permanents, so the reduction is {0}: the total cost is {10}{G}{G}. **Seat 0 taps all 12 lands** (2 Forests, 10 Wastes). Megasloth enters tapped. (Forge: all 12 tapped.)

## 4. Why

1. 601.2f: the total cost is the mana cost plus additional costs minus cost reductions. Megasloth's reduction is {1} per counter.
2. Counters are markers on objects or players (122.1). Count every counter on every permanent and every player at the time the total cost is determined (601.2f). Here none exist.
3. Seal of Fire, Millstone and the creatures have no counters in this setup (the board is placed directly, nothing is put on them).

## 5. What phase did

phase tapped only the two Forests: it reduced the generic part by 10 (the full {10}) with no counters on the board. The other 10 Wastes stayed untapped.

## 6. Variations to test

- **Some counters:** two +1/+1 counters on seat 1's Grizzly Bears and one poison counter on seat 0 → 3 counters, total cost {7}{G}{G}.
- **Counters of many kinds:** loyalty counters on a planeswalker, lore counters on a Saga, a stun counter, energy counters on a player all count.
- **More counters than generic mana:** 15 counters → total {G}{G}; the coloured part is never reduced (118.7a).
- **Mana value unchanged:** with any number of counters, Megasloth's mana value is 12 (ruling).
- **Counters in hidden or other zones:** counters on cards in graveyards or exile are not "among players and permanents" and don't count.

## 7. Acceptance checks

- On a board with no counters, casting Lumbering Megasloth costs {10}{G}{G}.
- Each counter on a permanent or player reduces the generic part by exactly {1}.


---

## Added from triage batch 2: Blaster Hulk ("costs {1} less for each {E} you've paid or lost this turn", with none paid)

## Spec: Blaster Hulk's cost is reduced although no energy was paid this turn

Scenario: `card-blaster-hulk` (card sweep, batch 2).

### 1. Card

- **Blaster Hulk** {6}{R}{R}, Artifact Creature — Pirate, 8/8. "This spell costs {1} less to cast for each {E} (energy counter) you've paid or lost this turn. / Haste / Whenever this creature attacks, you get {E}{E}, then you may pay eight {E}. When you do, this creature deals 8 damage divided as you choose among up to eight targets."
  - Ruling 2024-06-07: "Casting Blaster Hulk doesn't allow you to pay any {E}. It counts only {E} you've paid or lost that turn before you cast it."

### 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Mountain, Mountain + 6 Wastes. Seat 0 has no energy counters and has paid or lost none this turn. Seat 0 casts Blaster Hulk.

### 3. Correct result

The reduction is {0}, so the total cost is {6}{R}{R}. Seat 0 taps all eight lands. Blaster Hulk resolves and is an 8/8 on seat 0's battlefield. (Forge matches: all six Wastes tapped.)

### 4. Why

1. 601.2f: the total cost is the mana cost plus additional costs and increases, minus reductions. The reduction counts {E} paid or lost **this turn**, before the spell is cast (ruling). That number is 0 here.
2. 118.7a: a reduction of generic mana affects only the generic part, so even a large reduction never touches {R}{R}.

### 5. What phase did

Cast Blaster Hulk paying only {R}{R} (two Mountains); the six Wastes stayed untapped. phase reduced the cost by 6 with no energy paid or lost.

### 6. Variations to test

- Earlier in the turn seat 0 gets {E}{E}{E} and pays 3 (e.g. via Localized Destruction or another energy card): Hulk costs {3}{R}{R}.
- Seat 0 has 5 energy but has paid none this turn: full cost.
- Energy paid on a previous turn: doesn't count.
- Energy lost (not paid) this turn, e.g. to an opponent's effect: counts.
- 10 energy paid this turn: cost {R}{R} (generic can't go below 0; colored unaffected).

### 7. Acceptance checks

- On this board, Blaster Hulk can't be cast with only the two Mountains; casting it taps all eight lands, and it ends on the battlefield as an 8/8.
