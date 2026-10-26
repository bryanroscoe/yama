# Spec: Localized Destruction protects a creature whose power doesn't match the energy paid

Scenario: `card-localized-destruction` (card sweep, batch 2).

## 1. Card

- **Localized Destruction** {3}{W}{W}, Sorcery. "You get {E} (an energy counter), then you may pay one or more {E}. If you do, each creature you control with power equal to the amount of {E} paid this way gains indestructible until end of turn. / Destroy all creatures."
  - Rulings 2024-06-07: "To pay one or more {E}, you lose that many energy counters. You can't pay more energy counters than you have."

## 2. Board and actions

Board (the generated sweep board, `referee/sweep.py`): two players at 20 life, seat 0 active in its precombat main phase with an empty stack. Seat 0 controls exactly the lands that pay the card's mana cost (listed per card below) and an untapped Grizzly Bears (2/2 green Bear); its hand is the card and a Wastes; its graveyard holds Hill Giant (creature, mana value 4) and Divination (sorcery, mana value 3); its library is 8 Wastes. Seat 1 controls Grizzly Bears, Serra Angel (4/4 white Angel, flying, vigilance), Millstone (artifact) and Seal of Fire (enchantment); its hand is 2 Wastes; its graveyard holds Hill Giant; its library is 8 Wastes. Nothing is tapped and nothing has summoning sickness. Seat 0 casts the card with no optional or alternative costs. Targets given below were fixed for both engines.

Lands Plains, Plains + 3 Wastes. Seat 0 starts with no energy. Seat 0 casts Localized Destruction; it resolves.

## 3. Correct result

Seat 0 gets 1 energy. It may pay 1 (it can't pay more). phase's AI paid 1. Creatures seat 0 controls with power 1: none (Grizzly Bears has power 2), so nothing gains indestructible. Then all creatures are destroyed: seat 0's Grizzly Bears, seat 1's Grizzly Bears and Serra Angel all go to their owners' graveyards. Same outcome if seat 0 doesn't pay. (Forge matches.)

## 4. Why

1. 608.2c: the indestructible grant covers only creatures **you control** whose power **equals** the amount paid. With 1 paid, only power-1 creatures qualify.
2. Grizzly Bears (power 2) doesn't qualify, so it isn't indestructible (702.12b) and "Destroy all creatures" destroys it (701.8).
3. Seat 0 can't pay 2: it has only 1 energy (ruling; 118.3).

## 5. What phase did

Seat 0 got 1 energy and paid 1; then seat 1's Grizzly Bears and Serra Angel were destroyed but **seat 0's Grizzly Bears survived**.

## 6. Variations to test

- Seat 0 starts with 1 energy (2 after the spell's {E}) and pays 2: seat 0's Grizzly Bears gains indestructible and survives; everything else dies.
- Pay 2 with a 2-power creature and a 3-power creature: only the 2-power one survives.
- Opponent's 1-power creature when seat 0 pays 1: still destroyed (only "you control").
- Pay 0 (decline): everything is destroyed.
- Power checked as the grant is applied: a creature pumped to 2 earlier in the turn counts as power 2.

## 7. Acceptance checks

- On this board, after Localized Destruction resolves, no creatures remain on the battlefield, seat 0's graveyard includes Grizzly Bears, and seat 0 has 0 energy if it paid (1 if it didn't).
