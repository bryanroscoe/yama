# Spec: Incite Rebellion also damages each creature the player controls

Scenario: `card-incite-rebellion` (card sweep, standard sweep board; see `referee/README.md` and `referee/sweep.py`). Observed: Forge deals 1 to seat 0 and its Bears, 2 to seat 1 and each of its creatures (seat 1's Bears dies). Phase deals 1 to seat 0 and 2 to seat 1 and nothing to any creature.

## 1. Card

- **Incite Rebellion** ({4}{R}{R} sorcery): "For each player, Incite Rebellion deals damage to that player and each creature that player controls equal to the number of creatures they control."

Ruling (Scryfall): "The damage is dealt simultaneously. If this causes all players to have 0 or less life, the game is a draw."

## 2. Board and actions

Standard sweep board: seat 0 active in precombat main with 2 Mountains, 4 Wastes and Grizzly Bears (its only creature). Seat 1 controls Grizzly Bears (2/2), Serra Angel (4/4), Millstone, Seal of Fire (two creatures). Both at 20 life. Seat 0 casts Incite Rebellion.

## 3. Correct result

1. Count each player's creatures once, as the effect is applied (608.2h): seat 0 has 1, seat 1 has 2. All the damage is dealt at the same time (ruling), so no count changes partway.
2. Seat 0 and each creature seat 0 controls are dealt 1 damage: seat 0 goes to 19, seat 0's Bears has 1 damage (survives).
3. Seat 1 and each creature seat 1 controls are dealt 2 damage: seat 1 goes to 18, seat 1's Bears has 2 damage, Serra Angel has 2 damage.
4. State-based actions (704.5g): seat 1's Bears has lethal damage and dies. Serra Angel (4 toughness) survives with 2 damage.

Final: seat 0 life 19, its Bears 2/2 with 1 damage; seat 1 life 18, its Bears in its graveyard, Serra Angel with 2 damage. (Forge: exactly this.)

## 4. Why

The sentence names two kinds of recipient for each player: "that player" and "each creature that player controls" (608.2c). Damage to a creature is marked on it (120.3e) and checked by state-based actions.

## 5. What phase did

Dealt the right amount to each player and none to any creature; all creatures survive undamaged.

## 6. Variations to test

- **Player with no creatures:** that player is dealt 0 damage (no damage event), and has no creatures to damage.
- **Counts taken before damage:** seat 1 has three 1/1s and nothing else: each 1/1 and seat 1 are dealt 3 (not reduced as creatures die).
- **Lifelink/indestructible:** an indestructible creature survives with damage; the source is Incite Rebellion, so a creature's lifelink doesn't matter.
- **Draw:** both players at 1 life with at least one creature each: both go to 0 or less at the same time and the game is a draw (ruling).
- Similar wording: Mob Verdict ("deals 2 damage to that player and each creature that player controls"), see `votes-produce-no-result.md`.

## 7. Acceptance checks

- On the sweep board: seat 0 at 19 with its Bears marked with 1 damage; seat 1 at 18 with Serra Angel marked with 2 damage and its Bears in the graveyard.
